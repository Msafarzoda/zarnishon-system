#!/usr/bin/env bash
# Re-issues the server certificate for whatever address this machine currently has.
#
# The LAN address changes when the factory moves between a router and a phone hotspot, and
# a certificate that does not name the address in the browser's bar is rejected outright.
# Run this after any such change; the root authority stays the same, so the machines that
# already trust it keep working and nothing has to be reinstalled on them.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

if ! command -v mkcert > /dev/null; then
  echo "mkcert насб нашудааст. / mkcert is not installed:  brew install mkcert" >&2
  exit 1
fi

LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [ -z "$LAN" ]; then
  echo "Суроғаи шабака ёфт нашуд. / No LAN address found — is the machine on the network?" >&2
  exit 1
fi

echo "Суроғаи ҳозира / Current address: $LAN"

mkcert -cert-file certs/zarnishon.pem -key-file certs/zarnishon-key.pem \
  localhost 127.0.0.1 ::1 "$LAN" zarnishon.local

# Copied next to the server certificate so the setup page can hand it to a new machine.
cp "$(mkcert -CAROOT)/rootCA.pem" certs/rootCA.pem

echo
echo "Тайёр. / Done.  Сервер:  npm run dev:lan"
echo "Суроға барои дигарон / Address for the other machines:  https://$LAN:3000"
