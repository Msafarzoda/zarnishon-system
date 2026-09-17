#!/usr/bin/env bash
#
# Every weight the weighbridge read for itself, and whether anything was paid on one.
#
# Written for one specific question: the Keli frame carries no decimal point, the parser
# was reading its seven digits as whole kilograms, and this factory's indicator sends
# tenths — so for as long as that lasted, every `source = 'indicator'` weighing was ten
# times too heavy. A weighing is only a number in a book; a payment made against one is
# money out of the drawer, so the two are counted separately.
#
# Reads only. Nothing here changes a row: a wrong weight is corrected by appending a
# superseding weighing with a reason, which is what §2 requires and what the Тарозу screen
# already does — never by an UPDATE that quietly rewrites history.
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-zarnishon-db}"
DB_NAME="${DB_NAME:-zarnishon}"

docker exec -i "$DB_CONTAINER" psql -U zarnishon -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
\echo ''
\echo '=== Вазнҳои аз индикатор гирифташуда / weighings the indicator supplied ==='
SELECT
  count(*)                                        AS weighings,
  min(captured_at)::date                          AS first_day,
  max(captured_at)::date                          AS last_day,
  coalesce(round(min(weight_g) / 1000.0, 1), 0)   AS lightest_kg,
  coalesce(round(max(weight_g) / 1000.0, 1), 0)   AS heaviest_kg
FROM weigh_events
WHERE source = 'indicator';

\echo ''
\echo '=== Онҳое, ки пардохт шудаанд / of those, ones already paid for ==='
\echo '(Ҳар сатр — пули аз хазина рафта. Холӣ бошад, ҳеҷ пул бо рақами нодуруст дода нашудааст.)'
SELECT
  t.serial,
  c.name                                AS farm,
  round(t.net_g / 1000.0, 1)            AS net_kg,
  round(p.cash_payable_d / 100.0, 2)    AS paid_somoni,
  p.paid_at::date                       AS paid_on
FROM payments p
JOIN weigh_tickets t ON t.id = p.ticket_id
JOIN counterparties c ON c.id = p.counterparty_id
WHERE p.reversed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM weigh_events e
     WHERE e.ticket_id = t.id AND e.source = 'indicator'
  )
ORDER BY p.paid_at;

\echo ''
\echo '=== Борхатҳои кушода бо вазни индикатор / open tickets carrying an indicator weight ==='
\echo '(Инҳо ҳанӯз пардохт нашудаанд — вазнро дубора гиред, пеш аз он ки пул дода шавад.)'
SELECT
  t.serial,
  c.name                        AS farm,
  t.status,
  round(t.gross_g / 1000.0, 1)  AS gross_kg,
  round(t.tare_g  / 1000.0, 1)  AS tare_kg
FROM weigh_tickets t
JOIN counterparties c ON c.id = t.consignor_id
WHERE t.status IN ('OPEN', 'WEIGHED', 'ANALYSED')
  AND EXISTS (
    SELECT 1 FROM weigh_events e
     WHERE e.ticket_id = t.id AND e.source = 'indicator'
  )
ORDER BY t.serial;
SQL

echo
echo "Агар ҳар се рӯйхат холӣ бошанд — ҳеҷ вазни нодуруст сабт нашудааст."
echo "If all three are empty, no weight was ever recorded from the indicator and there is nothing to correct."
