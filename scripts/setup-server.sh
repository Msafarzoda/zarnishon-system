#!/usr/bin/env bash
#
# Turns a Linux Mint / Ubuntu laptop into the factory server.
#
# Safe to run more than once: every step checks before it changes anything, so this is
# also how you repair a machine that has drifted.
#
#   sudo bash scripts/setup-server.sh
#
# What it sets up, and why each piece is here:
#
#   * The server starts by itself when the power comes back, with nobody in the building.
#   * The lid can be closed. On a laptop this is the single most common way the server
#     silently stops — the machine suspends and every station says "offline".
#   * The battery is the UPS, and the machine shuts down *cleanly* before it is flat, so
#     Postgres closes its files instead of being cut off mid-write.
#   * Backups four times a day, each one verified.
#   * Remote access over Tailscale, which needs no port forwarding and no static IP.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/zarnishon}"
APP_USER="${APP_USER:-zarnishon}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Иҷро кунед бо sudo. / Run with sudo:  sudo bash scripts/setup-server.sh" >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()  { printf '    ✓ %s\n' "$*"; }

# ---------------------------------------------------------------- packages
say "Барномаҳо / Packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync git ufw > /dev/null
ok "base packages"

if ! command -v docker > /dev/null; then
  curl -fsSL https://get.docker.com | sh > /dev/null
  ok "docker installed"
else
  ok "docker already present"
fi
systemctl enable --now docker > /dev/null
ok "docker starts on boot"

if ! command -v node > /dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
  ok "node $(node -v) installed"
else
  ok "node $(node -v) already present"
fi

# ---------------------------------------------------------------- the service account
say "Ҳисоби система / Service account"
if ! id "$APP_USER" > /dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /bin/bash "$APP_USER"
  ok "created $APP_USER"
else
  ok "$APP_USER exists"
fi
# docker: to talk to the database container.  dialout: to read the weighbridge indicator
# on /dev/ttyUSB0 — without it the port is there and every open fails with "permission
# denied", which reads on screen as a scale that is not sending.
usermod -aG docker,dialout "$APP_USER"
ok "added to docker and dialout groups"

# ---------------------------------------------------------- laptop power behaviour
say "Рафтори лэптоп / Laptop behaviour"

# The lid. A laptop server with its lid open on a gin floor collects cotton lint in the
# keyboard; closed, the default is to suspend and take the whole factory offline.
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/99-zarnishon.conf <<'CONF'
# The server must keep running with the lid shut — closing it is not a request to stop.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
HandleLidSwitchExternalPower=ignore
IdleAction=ignore
CONF
ok "lid closed no longer suspends"

# Never sleep, never hibernate. A suspended server is indistinguishable from a dead one.
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target > /dev/null 2>&1 || true
ok "suspend and hibernate disabled"

# The battery is the UPS. Shut down cleanly at 8% rather than being cut off mid-write:
# Postgres survives a hard cut, but the margin is free and recovery is slow on a laptop
# disk — ten minutes of replay is ten minutes the weighbridge cannot weigh.
if [ -f /etc/UPower/UPower.conf ]; then
  sed -i 's/^PercentageAction=.*/PercentageAction=8/' /etc/UPower/UPower.conf
  sed -i 's/^CriticalPowerAction=.*/CriticalPowerAction=PowerOff/' /etc/UPower/UPower.conf
  systemctl restart upower > /dev/null 2>&1 || true
  ok "clean shutdown at 8% battery"
fi

# Updates must never reboot the machine on their own. A reboot at 03:00 is survivable; a
# reboot at 14:00 with a truck on the platform is not.
if [ -d /etc/apt/apt.conf.d ]; then
  cat > /etc/apt/apt.conf.d/99-zarnishon-no-reboot <<'CONF'
// Security updates yes, surprise reboots no. Reboot is a decision for a person, taken
// when the weighbridge is empty.
Unattended-Upgrade::Automatic-Reboot "false";
CONF
  ok "automatic reboots disabled"
fi

systemctl restart systemd-logind > /dev/null 2>&1 || true

# ---------------------------------------------------------------- the application
say "Система / Application"
if [ ! -d "$APP_DIR" ]; then
  echo "    !  $APP_DIR ёфт нашуд. Кодро ба он ҷо нусхабардорӣ кунед. / not found — copy the code there first."
  echo "       sudo mkdir -p $APP_DIR && sudo chown -R $APP_USER:$APP_USER $APP_DIR"
else
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  ok "$APP_DIR owned by $APP_USER"
fi

for UNIT in zarnishon.service zarnishon-backup.service zarnishon-backup.timer; do
  if [ -f "$APP_DIR/deploy/$UNIT" ]; then
    install -m 644 "$APP_DIR/deploy/$UNIT" "/etc/systemd/system/$UNIT"
    ok "installed $UNIT"
  fi
done
systemctl daemon-reload
systemctl enable zarnishon.service > /dev/null 2>&1 && ok "server starts on boot" || true
systemctl enable --now zarnishon-backup.timer > /dev/null 2>&1 && ok "backups every 6 hours" || true

# ---------------------------------------------------------------- remote access
say "Дастрасии дурдаст / Remote access"
if ! command -v tailscale > /dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh > /dev/null 2>&1
  ok "tailscale installed"
else
  ok "tailscale already present"
fi

apt-get install -y -qq openssh-server > /dev/null
systemctl enable --now ssh > /dev/null 2>&1 || systemctl enable --now sshd > /dev/null 2>&1 || true
ok "ssh enabled"

# The firewall allows the LAN in and nothing from outside. Remote access arrives through
# Tailscale, which does not need an open port — that is the whole reason for using it
# rather than forwarding 22 on the factory router.
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow in on tailscale0 > /dev/null 2>&1 || true
for NET in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do
  ufw allow from "$NET" to any port 22 proto tcp > /dev/null
  ufw allow from "$NET" to any port 3000 proto tcp > /dev/null
  ufw allow from "$NET" to any port 3001 proto tcp > /dev/null
done
ufw --force enable > /dev/null
ok "firewall: LAN and tailscale only"

cat <<EOF

────────────────────────────────────────────────────────────
Тайёр. / Done.  Ду қадами охирин, ки парол мепурсанд:

1.  Tailscale-ро пайваст кунед / Connect Tailscale:
      sudo tailscale up --ssh

    Пайванди додашударо кушоед. Баъд аз ҳар ҷо:
      ssh $APP_USER@zarnishon         (аз телефон ё ноутбуки шумо)

2.  BIOS: «Restore on AC Power Loss» → Power On
    Агар лэптоп батареяи солим дошта бошад, ин лозим нест —
    батарея UPS аст ва мошин хомӯш намешавад.

Санҷиш / Check:
      systemctl status zarnishon
      journalctl -u zarnishon -f
      ls -lh $APP_DIR/backups | tail -5
────────────────────────────────────────────────────────────
EOF
