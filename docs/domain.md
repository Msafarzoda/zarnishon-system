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

### Every truck is sampled

A sample is taken from **each load** once it has been weighed, and that truck's own
reading decides what its farmer is paid. So an analysis normally belongs to a
**ticket**, not to a партия.

The партия-level certificate the paper Форма №9-хл is written for still exists — a whole
lot certified at once — and covers any ticket in the lot that was not sampled
individually. When paying, **the truck's own analysis always wins.**

The lab prints a Форма №9-хл certificate per truck in three copies: лаборатория,
корхона, and the man who delivered it, who is entitled to see the deduction taken off
his cotton.

The lab samples the cotton and reports, per load:
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

> ✅ **DECIDED BY THE OWNER (13.09.2026): `EXCESS_OVER_NORM`.**
>
> The price per kg is the price for cotton **as it arrives** — normally damp — so the
> norms are already priced in and only the excess is deducted. Deducting the full
> measured percentage as well would take the same moisture off the farmer twice.
>
> The verbal description given earlier ("95 kg at 1.5 % → 98.5 % payable") describes
> `TOTAL`; it was a simplification. The real Форма №9-хл for партия 101 reads
> moisture 9 %, trash 2 %, which sit on the conditioned norms — consistent with the
> decision above.
>
> **Norms in force: moisture 800 bp (8 %), trash 200 bp (2 %).** These are the seeded
> defaults and still need Abdugafor's confirmation of the exact figures — they change
> what is deducted. `TOTAL` remains implemented and tested, and switching is a settings
> change, not a code change.
>
> The mode and norms in force are **frozen onto each analysis when it is approved**, so a
> later settings change never restates cotton that has already been paid for.

The lab head may **override** the computed `deduction_bp` with a mandatory reason.
Overrides are logged and surfaced on the owner's dashboard.

Lab results are **immutable once approved**. A re-analysis creates a new version;
tickets settled under the old version are not retroactively changed — a settled
payment is final unless explicitly reversed.

---

## 4. Step 3 — Payment (Пардохт)

### Price
The price per kg is set **only by the owner** (соҳиби корхона), as effective-dated
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

#### The lending limit — cotton in hand is the collateral

Decision of 15.09.2026: **nothing is lent without cotton behind it.** A farm may borrow up
to a fixed rate per kilogram of **its own undelivered-on cotton sitting in our warehouse**:

```
cotton_in_hand_g = Σ нетто of that farm's tickets that are weighed but not yet settled
max_advance_d    = cotton_in_hand_g × advance_rate_d_per_kg / 1000
headroom_d       = max_advance_d − outstanding_advance_d
```

`advance_rate_d_per_kg` is a factory setting the owner sets, like the deduction norms —
100 diram (1 сомонӣ) per kg to begin with. At that rate a farm with 3 000 kg in the shed
may borrow up to 3 000 сомонӣ, and not a diram more.

Three things this deliberately does **not** do:

- **No lab deduction is applied.** The cap is on raw нетто, not payable weight. It is a
  lending limit, not a valuation — the margin between 1 сомонӣ and the real price per kg
  is what makes it safe, and applying a deduction on top would only make it arbitrary.
- **Settled cotton stops being collateral.** Once a борхат is settled the cotton is ours
  and the money is the farm's; it has moved to the other side of the books and cannot
  secure a loan as well.
- **It is not a credit score.** A farm with no cotton in the shed can borrow nothing,
  however long we have known them.

### Paying a farm, not a ticket

A farm delivers four or five loads over a season and comes in once, months later, saying
*«6 000 сомонӣ мехоҳам»* — an amount, not a борхат. So the cash desk starts from the farm:

1. Value everything it has in hand at **today's** price.
2. Settle its oldest борхатҳо, whole, until they cover the amount asked for. Oldest first,
   because that is the order the cotton came in and the only order nobody has to argue
   about. A борхат cannot be split — it is one ticket, one price, one settlement.
3. Recover any outstanding advance out of what those settlements come to, in the usual way.
4. Hand over exactly what was asked for. Anything the last ticket settled beyond it stays
   on the farm's balance to collect later.

If everything in hand does not cover the amount asked for, the desk says so and offers
what it does cover. It never settles more than it must.

At settlement:
```
offset_d       = min( outstanding_advance_d, gross_amount_d )
cash_payable_d = gross_amount_d − offset_d
```
The offset reduces the farm's outstanding advance balance. Any remaining advance stays
outstanding against future deliveries.

### Settlement and disbursement are two different events

Decision of 14.09.2026, from the cash desk: a farm whose борхат settles at 6 000 сомонӣ
routinely wants only 2 000 or 3 000 today, and some days the drawer does not hold enough
to pay in full even when the farm wants it all. The old model — one ticket, one payment,
all the cash at once — could not express either case, so the desk had no way to record a
part-payment and no record of what was still owed.

Money therefore moves in **two** steps, and they are separate ledger transactions:

**1. Ҳисоббаробаркунӣ (settlement)** — the farm surrenders Copy C and accepts the price.

```
Dr COTTON_PURCHASE        gross_amount_d
  Cr ADVANCE_RECEIVABLE                  advance_offset_d
  Cr FARM_PAYABLE                        cash_payable_d
```

No cash moves. The ticket goes `ANALYSED → PAID`, meaning *settled and closed* — it can
never be settled again. What the factory now owes sits on the farm's `FARM_PAYABLE`
account.

**2. Пардохти нақдӣ (disbursement)** — cash actually leaves the drawer, any amount, any
number of times, until the balance is nil.

```
Dr FARM_PAYABLE      amount_d
  Cr CASH                       amount_d
```

**The price is fixed at settlement, not at each disbursement.** The farm chose the day it
handed over Copy C; taking the money in instalments afterwards is a cash arrangement, not
a second bet on the price. A farm that wants to keep speculating simply does not settle —
it keeps Copy C, and the ticket stays `ANALYSED`.

### Payment rules
1. Settlement requires an **ANALYSED** ticket with an **approved lab analysis**.
2. A ticket can be settled **once**. Enforced by a unique constraint, not by UI.
3. The cashier **cannot** create tickets, set prices, or enter lab results.
4. Every movement writes **ledger entries**; cash on hand and every farm balance are
   always **derived by summing the ledger**, never stored as mutable numbers.
5. Settling prints a receipt in **two copies** — хазина and the farm. It states what was
   handed over today and what is still owed, so the farm's copy is the claim on the rest.
6. A farmer who declines to settle today keeps Copy C; the ticket stays `ANALYSED`.
7. A disbursement may never exceed either the farm's outstanding balance or the cash in
   the drawer. Both are checked inside the same transaction that posts it.
8. Paying nothing at settlement is allowed and normal — it is how "we will pay you later"
   is recorded instead of being remembered.

### Ticket status machine
```
DRAFT → OPEN (gross taken)
OPEN → WEIGHED (tare taken, net known)
WEIGHED → ANALYSED (lab approved for its batch)
ANALYSED → PAID (settled at the day's price, copy C surrendered —
                 the cash itself may follow later, in instalments)
any → VOID (reason mandatory, owner-visible)
```

**A load must pass the weighbridge AND the lab before a single somoni can be paid.**
The status machine is what enforces it: `PAY` is only legal from `ANALYSED`, and the only
way into `ANALYSED` is an approved analysis.

**WEIGHED → ANALYSED happens in three places**, and all three are needed:

1. The lab approves that truck's own sample — the normal case, one truck.
2. The lab approves a партия certificate — every weighed ticket in the lot that has no
   sample of its own is promoted.
3. A truck is weighed into a партия **that is already certified**, and is promoted
   immediately on tare.

Without (3) a truck arriving after the lot was certified would sit at `WEIGHED` for ever
— no second approval is coming — so it would never become payable and would simply not
appear at the cash desk. The farmer would be holding a stamped Copy C for cotton the
system had quietly lost.

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

### One person holding several roles

Decision of 15.09.2026, for the first season: **the factory is running the paper process
and this system side by side**, and only one operator is entering data. тарозубон holds
`weigher`, `lab`, `cashier` and `accountant` at once. The лаборант keeps writing Форма
№9-хл by hand, the тарозубон takes the sheets and types them in.

A user therefore has a **primary role** — which decides where they land after signing in
and what they are called on screen — and any number of **extra roles** granted on top.
Every permission check tests the union.

This is a deliberate suspension of §5's separation of duties, and it is worth being exact
about what is given up. With one person holding the scale, the lab and the cash drawer,
the system can no longer stop that person inventing a load and paying themselves for it.
What still holds:

- **Every record still says who made it.** The audit log names Тарозубон on the weighing,
  the analysis and the payment, so the sequence is legible afterwards rather than hidden.
- **The paper is the control.** During the parallel season the hand-written борхат and
  Форма №9-хл exist independently of anything typed, and the two can be compared. That
  comparison — not the software — is what makes this safe for now.
- **Arithmetic controls are untouched.** A ticket still cannot be paid twice, the drawer
  still cannot go negative, weights still have to match their events.

Splitting the roles back apart is removing extra roles from one account. Nothing else in
the system needs to change, which is the point of granting them this way rather than by
loosening the checks.

### The farm's identity is its РМА

Decision of 15.09.2026: a хоҷагӣ is identified by its **tax number** (РМА / РЯМ / ИНН),
not by its name. Names are written differently on different waybills — «х-д Намуна»,
«хочагии Намуна Н», «Намуна» — and a farm that appears twice under two spellings has its
cotton, its advances and its balance split across two records that nobody notices.

So the РМА is unique across farms, required when a farm is created, and is what search
matches first. A farm that delivered once three seasons ago is found by typing its number.

---

## 7. Phase 2 — Ginning, outputs and stock

Recorded 16.09.2026 from the owner's description. Not yet built; this is the contract the
building will follow, the way §2–§4 were settled before the intake was written.

### The shape of it

Cotton goes in one side of the factory and four things come out of the other:

```
                    ┌──────────────┐
  пахта  ──────────▶│   ЗАВОД      │──────▶  чигит   ~57 %   sold to oil factories
  (from a бунт)     │  (ginning)   │──────▶  кип      ~33 %   pressed bales, sold at
                    │              │                          the end of the season
                    │              │──────▶  улюк      ~1 %   sold, or fed back through
                    └──────────────┘──────▶  пучоқ    ~9 %   trash: leaves, dust, waste
```

The owner's figures: чигит 56–58 %, улюк about 1 %, bales 210–215 kg each. Lint at about
33 % makes those add to 100, which is what a working gin looks like.

### The mass balance is the whole control

```
пахтаи фиристодашуда  =  чигит + кип + улюк + пучоқ + талафот
```

**This is the anti-fraud control for the factory**, and it is a different one from
everything in §2–§4. Those protect a farmer from being underpaid by a kilogram at a time.
This protects the factory from losing a tonne at a time — and lint is the valuable output,
so a few tonnes of it leaving quietly is worth more than every trick a weighbridge
operator could manage in a season.

It only works if **what goes in is weighed**. Cotton is weighed at intake and paid for, but
nothing currently records the weight fed into the gin, and without that there is no
equation — only a pile of outputs that could be any size.

#### Cotton dries in the бунт, and that is not theft

A farm is paid for нетто at intake, at 9 % moisture. Three weeks later that cotton goes
into the gin weighing less, because some of it was water. A balance that compares outputs
against *intake* нетто therefore shows a shortfall every single time, on an honest run.

That is worse than no check at all: a warning that is always wrong is a warning everybody
learns to ignore, and it will still be ignored on the day it is right. Two ways out, and
the owner picks one:

1. **Weigh at the gin mouth.** The cotton going in is weighed, and the balance is exact.
2. **A moisture-loss allowance**, set by the owner like the deduction norms, applied
   between intake weight and expected input.

(1) is the honest one. (2) is the one that needs no new scale.

#### Улюк must not be counted twice

Улюк is sold, and is sometimes fed back through the machines. Cotton entering the gin is
therefore either **primary** (from a бунт, bought from a farm) or **recycled** (улюк from
an earlier run). Only primary counts towards yield: counting recycled улюк as input again
inflates throughput and quietly breaks every percentage the balance depends on.

### Production runs, not партия

A партия is a lot of cotton in a бунт. The gin runs continuously and may be fed from more
than one бунт in a shift, so outputs cannot honestly be attributed to a партия.

The unit is a **run** (`production_run`) — a shift with a start, an end, and an operator.
A run records what was consumed and what came out, and the balance is checked per run.
Attribution to a партия is possible only when a run was fed from exactly one, and the
system says which case it is rather than pretending.

### Кип — bales are stock, not a flow

Bales are pressed continuously and sold **at the end of the season**, so for most of the
year they sit in a warehouse. They are the factory's largest asset in that period, and the
question "how many кип do we have, and what are they worth" must be answerable at any
moment without anybody counting them by hand.

Each bale has:

- a **serial**, unique for the season, printed as a barcode
- its **weight**, from the bale scale
- its **grade** (сорт), which is what it will be priced on
- the **run** it came from — so a bad bale leads back to the cotton it was made from
- a **location**, and a history of moves
- a **state**: `IN_STOCK → SHIPPED → SOLD`, or `REPRESSED` when it goes back

#### The barcode carries the serial and nothing else

**Never the weight.** Weight lives in the database and is looked up by serial. A barcode
containing the weight can be reprinted by anyone with a label printer, and a 213 kg bale
then scans as 180 kg at the loading bay with nothing to contradict it.

This is the same rule as §2's: the number comes from the scale and the record, never from
something a person can retype.

#### Weighing bales by hand, for now

The bale scale is mechanical, so the weight is typed on a tablet at the press. That is a
hand-entered weight, which §2 otherwise forbids, and it is the factory's new weak point:
213 entered as 203, ten bales a day, is a hundred kilograms of lint a day.

Per bale this cannot be caught. What catches it is the **mass balance in aggregate** — a
run whose bales weigh less than its cotton can account for. Until a digital scale is
fitted the controls are:

- a plausible range (a bale far outside 180–240 kg is refused, not saved)
- every bale weight marked `source: manual`, like any typed weight
- the run's balance, which is where a systematic shortfall shows up

### Selling — three products, one ledger

Чигит, кип and улюк are all sold. Each sale posts into the same cash ledger as §4, so cash
on hand stays a single derived number:

```
Dr CASH (or RECEIVABLE)     amount
  Cr SALES_REVENUE                   amount
```

#### Outbound weighing is the mirror of intake

A чигит truck arrives **empty**: ТАРА first, load, then БРУТТО. Intake is the other way
round — БРУТТО on arrival, ТАРА after unloading. The ticket state machine in §4 only
allows gross-then-tare and must learn both directions.

Bales are not weighed this way. A long trailer cannot be brutto/tara'd usefully, so a
**shipment is the sum of the bales scanned onto it** — which is the point of giving each
bale a weight and a barcode in the first place.

### Still to decide

Written down because building on a guess is how a system ends up lying:

- **Weigh at the gin mouth, or a moisture allowance?** Everything above depends on it.
- **What yield range is normal**, so a run outside it can be flagged? The figures here are
  the owner's, but as targets, not as measured tolerances.
- **Is there a linter?** Many gins take a second, shorter fibre off the seed and sell it
  separately. Not mentioned; if it exists it is a fifth output and changes the balance.
- **Is 210–215 kg the lint alone, or with the wrapping and ties?**
- **Is пучоқ sold, or dumped?** Either way it is mass to account for.
- **Who records the bales** — the press operator, or молшинос? It is a role that does not
  exist yet.

---
