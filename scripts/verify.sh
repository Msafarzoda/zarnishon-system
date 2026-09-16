#!/usr/bin/env bash
# Rebuilds a throwaway database and walks the whole money path through it.
#
# It never touches the factory's own data: the checks settle tickets, empty the drawer and
# lend money, none of which may happen to real борхатҳо. `zarnishon_test` is dropped and
# recreated on every run, so the script always starts from a known seed.
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
TEST_URL="postgres://zarnishon:zarnishon@${DB_HOST}:${DB_PORT}/zarnishon_test"

echo "Сохтани базаи озмоишӣ zarnishon_test …"
# -v ON_ERROR_STOP=1 so a refused DROP stops here instead of letting the checks run
# against a half-rebuilt database and report a pass. Open connections from an earlier run
# are closed first; without that, DROP DATABASE refuses and every later step is a lie.
docker exec zarnishon-db psql -U zarnishon -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 'zarnishon_test' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS zarnishon_test;" \
  -c "CREATE DATABASE zarnishon_test OWNER zarnishon;" > /dev/null

DATABASE_URL="$TEST_URL" npx drizzle-kit push --force > /dev/null
# The seed refuses to run without a password, so the checks supply a throwaway one. It
# never reaches the factory's own database — this is a database built and dropped here.
SEED_PASSWORD="${SEED_PASSWORD:-verify-only-password}" \
  DATABASE_URL="$TEST_URL" npx tsx src/db/seed.ts > /dev/null

DATABASE_URL="$TEST_URL" npx tsx scripts/verify-money-path.ts
