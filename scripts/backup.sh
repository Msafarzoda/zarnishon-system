#!/usr/bin/env bash
#
# One database dump, verified, with the old ones pruned.
#
# A dump nobody has read back is a hope, not a backup — so every dump is immediately
# listed by pg_restore, which fails loudly on a truncated or corrupt file. That catches
# the case that matters: a backup taken while the disk was filling up, which writes a
# plausible-looking file that cannot be restored.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-60}"
STAMP=$(date +%Y%m%d-%H%M)
FILE="$DIR/zarnishon-$STAMP.dump"

mkdir -p "$DIR"

docker exec zarnishon-db pg_dump -U zarnishon -d zarnishon -Fc > "$FILE"

if ! docker exec -i zarnishon-db pg_restore --list < "$FILE" > /dev/null 2>&1; then
  echo "BACKUP FAILED VERIFICATION: $FILE" >&2
  mv "$FILE" "$FILE.corrupt"
  exit 1
fi

# Keep the last N, drop the rest.
ls -1t "$DIR"/zarnishon-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

SIZE=$(du -h "$FILE" | cut -f1)
echo "$(date '+%Y-%m-%d %H:%M')  $FILE  $SIZE  verified"

# A copy that never leaves the building is not a backup. Anything mounted at
# /media/zarnishon-backup (a USB stick left in the machine) gets one too.
for TARGET in /media/zarnishon-backup /mnt/zarnishon-backup; do
  if [ -d "$TARGET" ] && [ -w "$TARGET" ]; then
    cp "$FILE" "$TARGET/" && echo "  copied to $TARGET"
  fi
done

# And off-site, when the line happens to be up. Never fatal: the factory does not stop
# because the internet did.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rsync -az --timeout=30 "$DIR"/ "$BACKUP_REMOTE" 2>/dev/null \
    && echo "  synced to $BACKUP_REMOTE" \
    || echo "  off-site copy skipped (no connection)"
fi
