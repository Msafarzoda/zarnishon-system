# Installing at the factory

The server is a **laptop in the office**. Its battery is the UPS: when the power drops,
the weighbridge, the lab and the cash desk keep working off the laptop and the router,
and nothing stops. That is the whole reason it is not in the cloud.

The internet is only ever used to copy backups out. Losing it must never stop a truck.

---

## What runs where

```
       Keli D2008 indicator
              │  RS-232, 9600 8N1, continuous
              │
      USB-RS232 adapter (CH340 / PL2303)
              │
   ┌──────────┴───────────┐
   │  Weighbridge PC      │  Chrome — reads the port itself
   └──────────┬───────────┘
              │
           router (LAN)
              │
   ┌──────────┴───────────────────────────────────┐
   │  Office laptop — the server                  │
   │    Caddy   :443   https on the LAN           │
   │    app     :3000  Next.js                    │
   │    db      :5432  Postgres (not published)   │
   │    backup         nightly dump → ./backups   │
   └───────────┬──────────────────────────────────┘
               │ when the line is up
        off-site copy of the backups
```

The gate, lab and cash desk are ordinary browsers on the same LAN. Only the weighbridge
PC needs the serial adapter.

---

## 1. The laptop

Give it a **fixed address** on the router (e.g. `192.168.1.10`) — the stations are
configured to it, and it must not move when the router restarts.

Set it to **never sleep on lid close** while on mains *and* on battery. A laptop that
suspends when someone shuts the lid takes the whole factory with it.

```bash
cp .env.example .env.production
# DB_PASSWORD and SESSION_SECRET: long, random, different from each other
openssl rand -base64 32

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml exec app npm run db:migrate
```

Seed once, then **change every password immediately** — the seeded ones are in the
repository (`src/db/seed.ts`).

---

## 2. HTTPS, and why it is not optional

The weighbridge browser reads the indicator through the Web Serial API, and browsers only
allow that on a **secure origin**. Over plain `http://192.168.1.10` the port cannot be
opened, and the weighbridge falls back to somebody typing a weight — which is the one
thing this system exists to prevent.

Caddy issues the certificate itself, offline, from its own authority. On **each station**,
once:

1. Copy the root certificate off the laptop:
   ```bash
   docker compose -f docker-compose.prod.yml cp \
     proxy:/data/caddy/pki/authorities/local/root.crt ./zarnishon-root.crt
   ```
2. On Windows: double-click → Install Certificate → **Local Machine** → Place all
   certificates in **Trusted Root Certification Authorities**.
3. Open `https://192.168.1.10` — no warning.

Put the same address in the router's DNS as `zarnishon.local` if you would rather the
staff typed a name.

---

## 3. The weighbridge

**The scale does not plug into the server.** It plugs into the weighbridge PC, and that
PC's browser reads the port. The server only serves the app, so it can be a MacBook in the
office with nothing attached to it.



### The cable

The D2008's back panel carries four ports. The one to use is **通讯接口** — the DB9 on the
right, next to the round load-cell connector. Not 打印机接口 (DB25, printer) and not
大屏幕接口 (DB15, remote display).

```
D2008 通讯接口 (DB9 male)
        │
  DB9 female–female gender changer
        │
  USB→RS232 adapter (DB9 male, USB-A)
        │
  Weighbridge PC
```

Both the indicator port and the adapter are male, which is why the changer is
female-to-female. Add the male-female extension between adapter and changer if the PC is
more than about a metre away.

### The indicator

Under **设置**: continuous transmission, **9600** baud, **8 data bits, 1 stop bit, no
parity**.

On the PC, install the **CH340** or **PL2303** driver for the adapter, then confirm the
COM port appears under Device Manager → Ports.

### If nothing arrives

In order, before suspecting the app:

1. **Baud rate.** Try 4800, 19200, 2400, 1200 on the indicator. Wrong baud produces
   either silence or unbroken garbage.
2. **Continuous mode is actually on.** In command mode the indicator says nothing until
   asked.
3. **Pins 2 and 3 may need crossing.** RS-232 has a direction: if the indicator transmits
   on the same pin the PC transmits on, neither hears the other. A **null modem adapter**
   (about $3) swaps them. This is the usual cause when the cable is right and the settings
   are right — try it before replacing anything.

### Commissioning: check it against the display

Open **Тарозу**, connect, then expand **Маълумоти техникӣ — кадрҳои тарозу**. It shows the
raw bytes arriving and what the stream was identified as.

**Put a known weight on the platform and confirm the number on this screen matches the
number on the indicator's own display.** The manual describes the output only as "a short
ASCII string with a checksum", which fits several incompatible formats — so this is
checked once, by eye, before a single truck is weighed. If they do not match, send those
raw frames and the displayed weight and the parser can be corrected; the system has a
custom-protocol path for exactly this.

The 稳定 lamp on the indicator is the stability signal the capture button waits for. Watch
it: the button should go active at the same moment that lamp lights.

In the app, open **Тарозу** and press **Тарозуро пайваст кардан** once. Chrome asks which
port; pick the adapter. The choice is remembered, so the operator does not repeat it
every shift.

The screen then shows the live weight with **Устувор / Ноустувор**. The capture button
only becomes active once the platform has settled — a loaded truck rocks on its springs
for several seconds after it stops, and a reading taken too early is out by tens of
kilograms.

### Do not use a keyboard wedge

232key, WedgeLink and similar type the weight into whatever field has focus. That looks
like the same thing and is worth nothing: the operator can still type a different number,
and nothing records where the figure came from. This app reads the port itself, stores the
**raw indicator frame** with every weighing, and marks anything typed by hand as `manual`
with a written reason, which the owner sees on his dashboard.

### If the indicator fails

Typing a weight stays possible — trucks keep arriving whether or not the cable works — but
it costs a reason, and every instance is listed for the owner under **Вазнҳои дастӣ
воридшуда**. If that list is ever long, the equipment or someone using it needs attention.

---

## 4. Backups

A dump is written to `./backups` every night and the last 30 are kept. **That is only half
a backup** until a copy leaves the building:

```bash
# On the laptop, whenever the line is up
rsync -az --remove-source-files ./backups/ user@vps:/srv/zarnishon-backups/
```

Test a restore before the season starts, on a spare machine, from a real dump:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U zarnishon -d zarnishon --clean --if-exists < backups/<file>.dump
```

A backup nobody has restored is a hope, not a backup.

---

## 5. Day to day

| | |
|---|---|
| Check it is up | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Update | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |
| Check the books | Owner's dashboard — the integrity panel recomputes from raw rows on every load |

The stations keep working offline: each queues its work in the browser and sends it when
the laptop is reachable again. The badge in the corner shows what is waiting, and opens
to list it.


---

## Testing before the scale is wired

The weighbridge screen has a **simulated indicator** in development: press one of the
weight buttons and it streams the same Toledo frames a Keli D2008 emits, through the same
framer and the same parser, including the two seconds of bouncing before the platform
settles. That last part is the point — it is what shows why the capture button waits.

Anything weighed while it runs is stored as **hand-entered with the reason "Тарозуи сунъӣ
(озмоиш)"**, never as a reading from the indicator, so a rehearsal can never be mistaken
later for a real weighing. The buttons do not exist when `NODE_ENV=production`.

### A dry run on one laptop

```bash
npm run dev
```

Then from any device on the same Wi-Fi, open `http://<laptop-ip>:3000` — the address the
laptop answers on, e.g. `http://172.20.10.9:3000`. Sign in on each device as the role
being rehearsed: `salimov` at the weighbridge, `laborant` at the lab, `hazinador` at the
cash desk, `safarov` for the owner's view.

Note that **the real serial port needs https**, so `npm run dev` over an IP address is for
rehearsing the workflow, not the scale. For the scale, run the production stack with Caddy
(section 2) — or plug the adapter into the server itself and use `http://localhost:3000`,
which browsers accept as a secure origin.
