import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baleState, feedSource, productKind, weighSource } from "./enums";
import { batches, storageLocations, varieties } from "./cotton";
import { counterparties, vehicles } from "./parties";
import { stations, users } from "./org";

/**
 * Phase 2 — what the factory does with the cotton once it has been paid for.
 *
 * The controlling idea, and the reason any of this exists: **the mass balance.**
 *
 *     пахтаи фиристодашуда = чигит + кип + улюк + пучоқ + талафот
 *
 * §2–§4 protect a farm from losing a kilogram. This protects the factory from losing a
 * tonne, and lint is the valuable half — which makes it the larger of the two risks.
 * None of it works without recording what went *in*, which is what `productionRuns` and
 * `runFeeds` are for. docs/domain.md §7.
 */

/**
 * Як баст — one shift at the gin.
 *
 * The unit is a run, not a партия. A партия is a lot of cotton in a бунт; the gin runs
 * continuously and may be fed from more than one in a shift, so attributing outputs to a
 * партия would be a guess dressed as a fact. Where a run happened to be fed from exactly
 * one партия the link is there to be read, and where it was not, the system says so
 * rather than inventing an answer.
 */
export const productionRuns = pgTable(
  "production_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    season: integer("season").notNull(),
    /** Human serial, e.g. "R-2026-000012". */
    serial: text("serial").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Null while the run is open. Outputs may still be recorded against it. */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    operatorId: uuid("operator_id")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("production_runs_serial_idx").on(t.serial),
    uniqueIndex("production_runs_client_uuid_idx").on(t.clientUuid),
    index("production_runs_season_idx").on(t.season, t.startedAt),
  ],
);

/**
 * Пахтаи фиристодашуда — cotton fed into the gin during a run.
 *
 * Append-only, like every weight in this system: a correction is another row that
 * supersedes, never an edit. Without these rows there is no left-hand side to the mass
 * balance and the outputs could be any size at all.
 */
export const runFeeds = pgTable(
  "run_feeds",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRuns.id),

    /** Where it came out of. */
    storageLocationId: uuid("storage_location_id").references(() => storageLocations.id),
    /** Set only when the бунт held exactly one партия, so the link is honest. */
    batchId: uuid("batch_id").references(() => batches.id),
    varietyId: uuid("variety_id").references(() => varieties.id),

    /**
     * Primary cotton counts towards yield; recycled улюк does not.
     *
     * Улюк is sold *and* sometimes fed back through. Counted as input a second time it
     * inflates throughput and quietly breaks every percentage the balance rests on.
     */
    source: feedSource("source").notNull().default("primary"),

    weightG: integer("weight_g").notNull(),
    /** Where the number came from. A typed weight must say why. */
    weighSource: weighSource("weigh_source").notNull().default("manual"),
    reason: text("reason"),
    indicatorRaw: text("indicator_raw"),

    fedAt: timestamp("fed_at", { withTimezone: true }).notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => users.id),
    supersedesId: uuid("supersedes_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_feeds_client_uuid_idx").on(t.clientUuid),
    index("run_feeds_run_idx").on(t.runId),
  ],
);

/**
 * Маҳсулоти фалокӣ — bulk output of a run: чигит, улюк, пучоқ.
 *
 * Bales are not here. A bale is an object with a serial and a life of its own; these are
 * quantities in a heap, and what matters about them is how much there is.
 */
export const runOutputs = pgTable(
  "run_outputs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRuns.id),

    product: productKind("product").notNull(),
    weightG: integer("weight_g").notNull(),
    storageLocationId: uuid("storage_location_id").references(() => storageLocations.id),

    weighSource: weighSource("weigh_source").notNull().default("manual"),
    reason: text("reason"),
    indicatorRaw: text("indicator_raw"),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => users.id),
    supersedesId: uuid("supersedes_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_outputs_client_uuid_idx").on(t.clientUuid),
    index("run_outputs_run_idx").on(t.runId, t.product),
  ],
);

/**
 * Кип — one pressed bale.
 *
 * Bales are **stock, not a flow**. They are pressed all season and sold at the end of it,
 * so for most of the year they are the factory's largest asset, and "how many do we have"
 * has to be answerable without anybody walking the warehouse counting.
 *
 * The weight is recorded once, at the press, and the bale carries it for life. A lorry of
 * bales is weighed by summing what was scanned onto it, because a long trailer cannot be
 * брутто/тара'd usefully.
 *
 * **The barcode carries `serial` and nothing else.** Never the weight: a barcode with the
 * weight in it can be reprinted by anyone with a label printer, and a 213 kg bale then
 * scans as 180 at the loading bay with nothing to contradict it. The scan looks the weight
 * up; it never carries it. Same rule as §2 — the number comes from the record, not from
 * something a person can retype.
 */
export const bales = pgTable(
  "bales",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),

    /** Unique for the season, and what the barcode encodes, e.g. "K-2026-004821". */
    serial: text("serial").notNull(),
    season: integer("season").notNull(),
    serialNumber: integer("serial_number").notNull(),

    runId: uuid("run_id").references(() => productionRuns.id),
    /**
     * Партия — and it is on the bale, not only reachable through the run.
     *
     * A run may be fed from more than one бунт, so the run cannot answer "which партия is
     * this bale?" in general. The warehouse asks exactly that, of a bale it is holding,
     * and it is what the serial and the label are built from: `K-2026-101-00042` is bale
     * 42 of партия 101. Recorded at the press by the person who watched it come out.
     */
    batchId: uuid("batch_id").references(() => batches.id),
    weightG: integer("weight_g").notNull(),
    /** Сорт — what it will be priced on. */
    grade: text("grade"),

    state: baleState("state").notNull().default("IN_STOCK"),
    storageLocationId: uuid("storage_location_id").references(() => storageLocations.id),

    /**
     * The bale scale is mechanical, so this is typed at the press — a hand-entered weight,
     * which §2 otherwise forbids. Per bale it cannot be checked; what catches a
     * systematic understatement is the run's mass balance, in aggregate.
     */
    weighSource: weighSource("weigh_source").notNull().default("manual"),
    reason: text("reason"),
    indicatorRaw: text("indicator_raw"),

    pressedAt: timestamp("pressed_at", { withTimezone: true }).notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("bales_serial_idx").on(t.serial),
    uniqueIndex("bales_client_uuid_idx").on(t.clientUuid),
    index("bales_state_idx").on(t.state, t.season),
    index("bales_run_idx").on(t.runId),
  ],
);

/** Every move a bale makes, so a missing one can be traced to where it last was. */
export const baleMoves = pgTable(
  "bale_moves",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    baleId: uuid("bale_id")
      .notNull()
      .references(() => bales.id),
    fromLocationId: uuid("from_location_id").references(() => storageLocations.id),
    toLocationId: uuid("to_location_id").references(() => storageLocations.id),
    movedAt: timestamp("moved_at", { withTimezone: true }).notNull().defaultNow(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => users.id),
    note: text("note"),
  },
  (t) => [index("bale_moves_bale_idx").on(t.baleId, t.movedAt)],
);

/**
 * Фурӯш — a sale of product, whichever way it left the yard.
 *
 * Bulk (чигит, улюк, пучоқ) is weighed on the weighbridge, тара then брутто, and carries
 * a `weighTicketId`. Кип is a set of bales and carries none — its weight is the sum of
 * the bales scanned onto the lorry.
 *
 * **The price is the owner's**, effective-dated like the cotton price in §4. A cashier or
 * a weighbridge operator never sets it.
 */
export const productSales = pgTable(
  "product_sales",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    season: integer("season").notNull(),
    invoiceNo: text("invoice_no").notNull(),

    product: productKind("product").notNull(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => counterparties.id),

    /** Bulk only: the тара→брутто ticket the weight came from, where one was raised. */
    weighTicketId: uuid("weigh_ticket_id"),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),

    /**
     * Bulk only, and the mirror image of intake: a lorry coming to *collect* arrives
     * empty, so тара is weighed first and брутто after loading. Kept on the sale itself
     * rather than as a Борхат, because there is no consignor, no lab and no партия — it
     * is one lorry, one buyer, one number, and burying it in the intake table would mean
     * every query about cotton bought had to learn to exclude it.
     */
    tareG: integer("tare_g"),
    grossG: integer("gross_g"),

    /**
     * Where each of the two numbers came from, and the indicator frame behind it.
     *
     * Weaker than intake, and knowingly so. On intake the **server** captures the weight
     * and the station never supplies one, because that number decides what a farm is paid
     * and the station has an interest in it. Here the station sends what it read. The
     * exposure runs the other way — understating an outbound weight costs the factory its
     * own money, not a farm's — and two things stand behind it: the raw frame is kept
     * verbatim, so a fabricated weight has to come with a fabricated Keli frame carrying a
     * correct checksum, and the product no longer in stock has to reconcile against what
     * the runs produced. If the same person ever both sells and reconciles, this is the
     * first thing to tighten. docs/domain.md §7.
     */
    tareSource: weighSource("tare_source").notNull().default("manual"),
    grossSource: weighSource("gross_source").notNull().default("manual"),
    tareRaw: text("tare_raw"),
    grossRaw: text("gross_raw"),
    /** Required whenever either number was typed rather than read. */
    weighReason: text("weigh_reason"),

    /** Bulk: брутто − тара. Кип: the sum of the bales scanned onto the lorry. */
    weightG: integer("weight_g").notNull(),
    /** Frozen at the moment of sale, like every price in this system. */
    priceDPerKg: integer("price_d_per_kg").notNull(),
    amountD: bigint("amount_d", { mode: "number" }).notNull(),
    /** False until the buyer has actually paid; the money is a receivable until then. */
    paid: boolean("paid").notNull().default(false),

    ledgerTxId: uuid("ledger_tx_id"),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    soldBy: uuid("sold_by")
      .notNull()
      .references(() => users.id),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    uniqueIndex("product_sales_client_uuid_idx").on(t.clientUuid),
    uniqueIndex("product_sales_invoice_idx").on(t.invoiceNo),
    index("product_sales_buyer_idx").on(t.buyerId),
    index("product_sales_sold_at_idx").on(t.soldAt),
  ],
);

/**
 * Which bales went in which sale.
 *
 * A row here is what makes a bale `SOLD`, and the sale's weight is the sum of its bales —
 * so a bale cannot be in two sales, and a sale cannot claim weight no bale accounts for.
 */
export const saleBales = pgTable(
  "sale_bales",
  {
    saleId: uuid("sale_id")
      .notNull()
      .references(() => productSales.id),
    baleId: uuid("bale_id")
      .notNull()
      .references(() => bales.id),
    /** The bale's weight as it stood when sold, frozen against later corrections. */
    weightG: integer("weight_g").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One bale, one sale. The index is the guarantee, not the screen.
    uniqueIndex("sale_bales_bale_idx").on(t.baleId),
    index("sale_bales_sale_idx").on(t.saleId),
  ],
);


/**
 * Нархи маҳсулот — what one kilogram of чигит, улюк, пучоқ or кип sells for.
 *
 * Effective-dated and insert-only, exactly like `priceQuotes` in §4, and for the same
 * reason: a sale made last Tuesday must keep last Tuesday's price for ever, however many
 * times the owner has moved it since. **Only the owner sets these.** The молшинос records
 * what left the yard; he does not decide what it was worth.
 */
export const productPrices = pgTable(
  "product_prices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    product: productKind("product").notNull(),
    priceDPerKg: integer("price_d_per_kg").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    setBy: uuid("set_by")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("product_prices_effective_idx").on(t.product, t.effectiveFrom)],
);

/**
 * Пули фурӯш қабул шуд — money a buyer handed over, against what they owe us.
 *
 * The mirror image of `disbursements` in §4, and kept separate from the sale for exactly
 * the same reason: a sale happens once, at a price, against a lorry-load, while payment
 * happens any number of times and against the buyer as a whole. A local who takes three
 * lorries of чигит in a week and settles on Friday has three sales and one receipt.
 *
 * So "has this sale been paid?" is not a flag anybody sets — it is the buyer's
 * BUYER_RECEIVABLE balance, summed from the ledger like every other balance here.
 */
export const saleReceipts = pgTable(
  "sale_receipts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => counterparties.id),
    /** Set when the buyer paid at the moment of sale; null for a later settlement. */
    saleId: uuid("sale_id").references(() => productSales.id),

    amountD: bigint("amount_d", { mode: "number" }).notNull(),
    /** What the buyer still owes after this — printed on the receipt. */
    balanceAfterD: bigint("balance_after_d", { mode: "number" }).notNull(),

    receiptNo: text("receipt_no").notNull(),
    ledgerTxId: uuid("ledger_tx_id").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    uniqueIndex("sale_receipts_client_uuid_idx").on(t.clientUuid),
    uniqueIndex("sale_receipts_receipt_idx").on(t.receiptNo),
    index("sale_receipts_buyer_idx").on(t.buyerId),
    index("sale_receipts_received_at_idx").on(t.receivedAt),
  ],
);
