# Zarnishon — ЧДММ «ЗАРНИШОН»

Системаи қабул, таҳлил ва пардохти пахта — cotton intake, laboratory and payment system
for a cotton ginning factory.

Interface language: **Tajik (Cyrillic)**, worded to match the paper forms the staff
already use. Code, comments and documentation are in English.

---

## What it does

**Phase 1 — the money path (this is what is being built now)**

1. **Қабул / Intake** — a loaded truck is weighed (Брутто), unloads into a партия and a
   бунт, and is weighed again empty (Тара). Нетто = Брутто − Тара. A serialized
   Борхат prints in three copies: guard, factory, and a stamped copy for the driver
   which is the farmer's claim to payment.
2. **Лаборатория / Laboratory** — Форма №9-хл records намӣ (moisture) and ифлосӣ (trash)
   per партия, which becomes the weight deduction.
3. **Пардохт / Payment** — the farmer hands in his stamped copy and is paid at the price
   in force **on the day of payment**, less any қарз (advance) his farm has taken.

**Later phases** — warehouse and ginning, lint bale press output, cottonseed sales,
outbound seed-truck weighing, and full per-batch mass balance. The schema already
reserves these; see `docs/domain.md` §7.

---

## Read this first

- **`docs/domain.md`** — the business rules, the glossary, the formulas, and the open
  question the owner must answer about how the lab deduction is calculated. The code
  follows that document; if a rule there is wrong, fix it there first.

---

## Setup

```bash
npm install
docker compose up -d        # Postgres 17 on localhost:5433
cp .env.example .env.local
npm run db:push             # create the schema
npm run db:seed             # reference data + the two real documents
npm run dev
```

Seeded users, all with password `zarnishon`:

| Username | Name | Role |
|---|---|---|
| `safarov` | Абдуғафор Сафаров | соҳиб (owner) |
| `salimov` | Салимов Ҷ. | тарозубон (weigher) |
| `sharipov` | Шарипов М. | молшинос (merchandiser) |
| `laborant` | — | лаборант (lab) |
| `hazinador` | — | хазинадор (cashier) |
| `posbon` | — | посбон (guard) |

The seed reproduces **Борхат №46 / Партия 101** (х-д Билол-Б, Газел 22-60, 3015 / 2380 /
635 кг) and its **Форма №9-хл** (9 % / 2 %) so the system can be checked line by line
against the paper.

---

## Commands

```bash
npm run dev          # development server
npm test             # domain tests — run these before trusting any money change
npm run typecheck
npm run db:push      # apply schema changes in development
npm run db:generate  # generate a migration for production
npm run db:studio    # browse the database
```

---

## Why the code is shaped this way

The stated goal is a system with **no gap where cotton or cash can slip out** — including
by what someone types into the system. That is a structural problem, so these are
structural properties, not policies:

| Control | How |
|---|---|
| No silent edits | Weigh events, lab results, cash ledger and payments are append-only. A mistake is corrected by a reversing entry with an author and a reason; both stay visible. |
| No double payment | `payments.ticket_id` is UNIQUE. Two cash desks racing, or an offline queue replaying, still cannot pay a ticket twice — the database refuses it. |
| No editable balances | Cash on hand and every farm's advance balance are `SUM()` over the ledger. There is no balance column for anyone to type over. |
| No lone actor | Weigher ≠ lab ≠ cashier ≠ owner. Only the owner sets the price. |
| No untraceable paper | Ticket serials come from contiguous pre-allocated blocks, so an unused serial is a visible gap that must be voided with a reason. |
| No float drift | Weights are integer grams, money integer diram, percentages integer basis points. Rounding is explicit at every call site. |
| No lost offline work | Every write from a station carries a client-generated UUID; replaying a queued operation returns the original result instead of repeating it. |

---

## Layout

```
docs/domain.md          business rules — the contract
src/domain/             pure logic: units, weights, deductions, settlement, ledger, ticket FSM
src/db/schema/          Drizzle schema
src/db/seed.ts          reference data + the two real documents
src/server/services/    transactional operations (weigh, approve, pay)
src/lib/i18n/tg.ts      Tajik interface strings
src/app/                Next.js screens
```

`src/domain` has no database and no framework in it. It is all pure functions, which is
why the arithmetic that decides what a farmer is paid can be tested exhaustively.
