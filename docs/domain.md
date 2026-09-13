# Zarnishon — Domain Model & Business Rules

ЧДММ «ЗАРНИШОН» — cotton ginning factory (хлопкозавод).
This document is the contract. Code follows this file; if a rule here is wrong, fix it here first.

---

## 0. Glossary (Tajik / Russian / English)

| Tajik (Cyrillic) | Russian | English | Code term |
|---|---|---|---|
| Борхати нақлиётию молӣ | ТТН | Waybill / scale ticket | `weigh_ticket` |
| Партия | Партия | Batch / lot | `batch` |
| Борфиристонанда | Грузоотправитель | Consignor (the farm) | `counterparty` |
| Боркабулкунанда | Грузополучатель | Consignee (us) | — |
| Фармоишгар (пулсупоранда) | Заказчик (плательщик) | Payer / customer | `payer` |
| Ронанда | Водитель | Driver | `driver` |
| Автомошин | Автомашина | Vehicle | `vehicle` |
| Хоҷагӣ (х-д) | Хозяйство | Farm | `counterparty.kind='farm'` |
| РЯМ / РМА | ИНН | Taxpayer ID (TIN) | `tin` |
| Брутто | Брутто | Gross weight (truck + cotton) | `gross_g` |
| Тара | Тара | Tare weight (empty truck) | `tare_g` |
| Нетто | Нетто | Net weight (cotton) | `net_g` |
| Намӣ | Влажность | Moisture / humidity % | `moisture_bp` |
| Ифлосӣ | Засорённость | Trash / foreign matter % | `trash_bp` |
| Навъи пахта | Селекционный сорт | Selection variety (e.g. С-6530) | `variety` |
| Сорт | Пром. сорт | Industrial grade (1–5) | `grade` |
| Синфи бор | Класс | Class | `class` |
| Анбор / Бунт / Навес | Склад / бунт / навес | Warehouse / stack / shed | `storage_location` |
| Молшинос | Товаровед | Commodity expert | role `merchandiser` |
| Посбон | Охранник | Security guard | role `guard` |
| Қарз / пешпардохт | Аванс / ссуда | Advance / short-term loan | `advance` |
| Пардохт | Оплата | Payment | `payment` |
| Хазина | Касса | Cash desk | `cash_account` |
| Тухмӣ | Семена | Cottonseed | `seed` |
| Кип / тюк | Кипа | Pressed lint bale | `bale` |

---

## 1. Units — never use floating point for these

| Quantity | Stored as | Example |
|---|---|---|
| Weight | **integer grams** (`_g`) | 3015 kg → `3_015_000` |
| Money | **integer diram** (`_d`), 1 сомонӣ = 100 дирам | 12.50 TJS → `1250` |
| Percent / rate | **integer basis points** (`_bp`), 1% = 100 bp | 1.5% → `150` |
| Price per kg | **diram per kg** (`price_d_per_kg`) | 12.50 TJS/kg → `1250` |

All rounding is explicit and stated at the call site. Money rounds **half-up to the diram**, in the farmer's favour only where a rule says so.

---

## 2. Step 1 — Intake (Қабули пахта)

### Physical flow
1. Loaded truck arrives at the gate. Guard registers arrival.
2. Truck drives onto the weighbridge → **Брутто** (gross) recorded.
3. Truck is directed to a storage location (анбор / бунт / навес) and assigned a **Партия** (batch).
4. Truck unloads.
5. Empty truck returns to the weighbridge → **Тара** (tare) recorded.
6. **Нетто = Брутто − Тара** — this is the cotton actually received.
7. Ticket (Борхат) is printed with a serial number.

### The three copies
The physical ticket is printed in **3 copies**, and this is a core control:

| Copy | Holder | Purpose |
|---|---|---|
| **A** | Посбон (guard) | Gate register: how many trucks are in, unloading, gone |
| **B** | Factory (accounting) | Our record |
| **C** | Driver / cotton owner | **Stamped. Bearer instrument.** Whoever holds it can claim payment. |

**Rule: Copy C is surrendered when paid.** No paper = already paid.
The system enforces this independently of the paper: a ticket may be paid **at most once**,
and `payment_id` on the ticket is unique. The paper and the system must agree; the
system is the authority, the paper is the farmer's receipt.

### Gate state machine (for the guard's screen)
```
ARRIVED → WEIGHED_GROSS → UNLOADING → WEIGHED_TARE → DEPARTED
```
Guard dashboard derives, at any moment: trucks on site, trucks unloading, trucks awaiting tare weigh.

### Weight capture
Weights are recorded as **append-only `weigh_event` rows**, never as editable fields.
Each event carries:
- `source`: `manual` | `indicator` (reserved for the direct scale feed)
- `operator_id`, `station_id`, `captured_at`, `device_fingerprint`
- optional `photo_ref` (photo of the indicator display — the manual-entry compensating control)

A wrong weight is never edited. A **correction event** is appended with `supersedes_id`
and a mandatory reason; both remain visible in the audit trail.

> The data model is already shaped for an automatic indicator feed. When the weighbridge
> indicator model is known, only the capture adapter changes — nothing downstream.

### Ticket serial numbers & offline
Stations issue serials from **pre-allocated blocks** (`serial_block`), so an offline
station can still print a valid, unique, non-guessable-in-sequence ticket.
Because blocks are contiguous, **a missing serial is detectable** — an unused or
destroyed ticket must be explicitly voided with a reason, and voids are reported to the owner.

---

## 3. Step 2 — Laboratory (Лаборатория, Форма №9-хл)

The lab samples the cotton and reports, per **партия**:
- **Влажность %** — moisture (`moisture_bp`)
- **Засорённость %** — trash content (`trash_bp`)

Form №9-хл carries two measurement points:
- cols 7–8: `on_intake` — средневзвешенные показатели по приёмке
- cols 9–10: `on_dispatch` — при отправке на завод

Payment uses the **`on_intake`** analysis.

### Payable (conditioned) weight

```
payable_g = round( net_g × (10000 − deduction_bp) / 10000 )
```

`deduction_bp` is produced by one of two configured modes:

**Mode `TOTAL`** — deduct the full measured percentages:
```
deduction_bp = moisture_bp + trash_bp
```

**Mode `EXCESS_OVER_NORM`** — deduct only what exceeds the contract norm (industry standard):
```
deduction_bp = max(0, moisture_bp − norm_moisture_bp) + max(0, trash_bp − norm_trash_bp)
```

> ⚠️ **OPEN QUESTION — must be confirmed by the owner before go-live.**
> The verbal description ("95 kg at 1.5% → 98.5% payable") describes `TOTAL`.
> But the real Form №9-хл for batch 101 reads **moisture ≈ 9%, trash ≈ 2%**. Under `TOTAL`
> that is an 11% deduction on every load, which is not how these contracts normally work —
> those figures sit right at the usual conditioned norms (≈8–9% moisture, ≈2–3% trash),
> which is the signature of `EXCESS_OVER_NORM`.
> The system ships configured as `EXCESS_OVER_NORM` with norms 800 bp / 200 bp.
> **Both modes are implemented and tested. Changing the mode is a settings change,
> not a code change — but it must be a deliberate, logged decision by the owner.**

The lab head may **override** the computed `deduction_bp` with a mandatory reason.
Overrides are logged and surfaced on the owner's dashboard.

Lab results are **immutable once approved**. A re-analysis creates a new version;
tickets settled under the old version are not retroactively changed — a settled
payment is final unless explicitly reversed.

---

## 4. Step 3 — Payment (Пардохт)

### Price
The price per kg is set **only by the owner** (Абдуғафор Сафаров), as effective-dated
`price_quote` rows, optionally per variety/grade/class. Price is never entered by a cashier.

**The price applied is the price in force on the date of payment — not the date of intake.**
This is the whole point of letting a farmer wait: he is speculating on a better price.

### Settlement of one ticket
```
payable_g       = net_g × (10000 − deduction_bp) / 10000        (from lab)
gross_amount_d  = round( payable_g × price_d_per_kg / 1000 )
```

### Advances (қарз)
A farm may take a **short-term loan against its name** — cash to pay pickers — before
selling. Advances sit on the **farm's** ledger, not on any single ticket.

At settlement:
```
offset_d       = min( outstanding_advance_d, gross_amount_d )
cash_payable_d = gross_amount_d − offset_d
```
The offset reduces the farm's outstanding advance balance. Any remaining advance stays
outstanding against future deliveries.

### Payment rules
1. Payment requires an **UNPAID** ticket with an **approved lab analysis**.
2. A ticket can be paid **once**. Enforced by a unique constraint, not by UI.
3. The cashier **cannot** create tickets, set prices, or enter lab results.
4. Every payment writes a **cash ledger entry**; cash on hand is always **derived by
   summing the ledger**, never stored as a mutable number.
5. Paying prints an invoice; the ticket moves `UNPAID → PAID` and Copy C is collected.
6. A farmer who declines payment today keeps Copy C; the ticket simply stays `UNPAID`.

### Ticket status machine
```
DRAFT → OPEN (gross taken)
OPEN → WEIGHED (tare taken, net known)
WEIGHED → ANALYSED (lab approved for its batch)
ANALYSED → PAID (cash paid, copy C surrendered)
any → VOID (reason mandatory, owner-visible)
```

---

## 5. Anti-fraud design principles

These are the reason the system exists. Every one of them is a structural property,
not a policy note.

1. **Append-only.** Weigh events, lab results, cash ledger and payments are never
   UPDATEd in place. Corrections are reversing entries carrying an author and a reason.
2. **Serialized bearer tickets.** Single-use, unique, pre-allocated in contiguous blocks
   so that missing paper is detectable.
3. **Separation of duties.** `weigher` ≠ `lab` ≠ `cashier` ≠ `owner`. No role can complete
   a money path alone.
4. **Derived balances.** Cash on hand, farm balances and stock are computed from ledgers.
   There is no field anybody can set.
5. **Mass balance.** Per batch: intake net must reconcile against stock, ginned output,
   lint bales, seed sold and declared waste, within a configured tolerance. Unexplained
   drift is a dashboard alarm, not a silent variance.
6. **Full audit trail.** Every mutation records user, role, station, device, timestamp
   and whether it originated offline.
7. **Idempotency.** Every write from a station carries a client-generated UUID. Replaying
   a queued offline operation can never double-pay or double-weigh.

---

## 6. Roles

| Role | Can do |
|---|---|
| `guard` (посбон) | See gate register; mark arrival/departure. No weights, no money. |
| `weigher` (тарозубон) | Capture gross/tare, assign batch + storage location, print ticket. |
| `lab` (лаборант) | Enter and approve Form №9-хл analyses. |
| `merchandiser` (молшинос) | Set variety/grade/class, manage batches and storage. |
| `cashier` (хазинадор) | Pay against tickets, record advances, close cash day. |
| `accountant` (муҳосиб) | Read all; post corrections with reason. Cannot pay. |
| `owner` (соҳиб) | Set prices, see everything, approve voids/overrides. |
| `admin` | User and station management. No money path. |

---

## 7. Out of phase 1 (designed for, not yet built)

Step 4+ — the schema reserves these and the mass-balance model assumes them:
- Warehouse/bunt stock movements and ginning (`production_run`)
- Lint bale press output per batch (`bale`)
- Cottonseed inventory and sales to oil factories
- Outbound weighing of seed trucks (empty-in → loaded-out, mirror of intake)
- Seed sale proceeds posting into the same cash ledger
