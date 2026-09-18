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
import { accountKind, ledgerTxKind } from "./enums";
import { counterparties } from "./parties";
import { stations, users } from "./org";
import { varieties } from "./cotton";
import { weighTickets } from "./intake";

/**
 * Нархи як кг — price per kilogram, in diram. Set by the owner only, effective-dated.
 * The price that pays a ticket is the one in force **on the day of payment**.
 */
export const priceQuotes = pgTable(
  "price_quotes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Null = applies to every variety. A more specific match wins. */
    varietyId: uuid("variety_id").references(() => varieties.id),
    grade: integer("grade"),
    cottonClass: text("cotton_class"),
    priceDPerKg: integer("price_d_per_kg").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    setBy: uuid("set_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [index("price_quotes_effective_idx").on(t.effectiveFrom, t.varietyId)],
);

// ------------------------------------------------------------------ ledger

/**
 * Double-entry accounts. Cash on hand and every farm's advance balance are **derived by
 * summing `ledgerEntries`** — there is no mutable balance field anybody can set.
 */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    code: text("code").notNull().unique(),
    nameTg: text("name_tg").notNull(),
    kind: accountKind("kind").notNull(),
    /** Set for ADVANCE_RECEIVABLE: whose advance this is. */
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_accounts_kind_idx").on(t.kind),
    uniqueIndex("ledger_accounts_advance_idx").on(t.kind, t.counterpartyId),
  ],
);

/**
 * One financial event. Its entries must sum to zero — checked in application code and
 * by `verifyLedgerBalanced()`. Nothing here is ever UPDATEd or DELETEd; a mistake is
 * corrected by a REVERSAL transaction pointing at the original.
 */
export const ledgerTx = pgTable(
  "ledger_tx",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    kind: ledgerTxKind("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    memo: text("memo"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    originatedOffline: integer("originated_offline").notNull().default(0),
    /** Set on a REVERSAL: the transaction being undone. */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    uniqueIndex("ledger_tx_client_uuid_idx").on(t.clientUuid),
    index("ledger_tx_occurred_idx").on(t.occurredAt),
    index("ledger_tx_kind_idx").on(t.kind),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    txId: uuid("tx_id")
      .notNull()
      .references(() => ledgerTx.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    /** Signed diram. Debit positive, credit negative. Entries of one tx sum to zero. */
    amountD: bigint("amount_d", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_entries_tx_idx").on(t.txId),
    index("ledger_entries_account_idx").on(t.accountId),
  ],
);

// ------------------------------------------------------------------ advances

/**
 * Қарз — a short-term loan to a farm, usually cash to pay cotton pickers, taken before
 * the farmer decides to sell. It sits on the **farm**, not on any one ticket, and is
 * recovered from whatever the farm is later paid. docs/domain.md §4.
 */
export const advances = pgTable(
  "advances",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id),
    principalD: bigint("principal_d", { mode: "number" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    purpose: text("purpose"),
    /** The cash-out transaction that funded it. */
    ledgerTxId: uuid("ledger_tx_id").references(() => ledgerTx.id),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("advances_client_uuid_idx").on(t.clientUuid),
    index("advances_counterparty_idx").on(t.counterpartyId),
  ],
);

// ------------------------------------------------------------------ payments

/**
 * Пардохт — paying a farmer for one ticket against the stamped Copy C he hands in.
 *
 * `ticketId` is UNIQUE: the database itself makes a second payment for the same ticket
 * impossible, independently of any screen, any role and any offline replay.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => weighTickets.id),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id),

    /** Everything that went into the number, frozen at the moment of payment. */
    netG: integer("net_g").notNull(),
    deductionBp: integer("deduction_bp").notNull(),
    payableG: integer("payable_g").notNull(),
    priceDPerKg: integer("price_d_per_kg").notNull(),
    priceQuoteId: uuid("price_quote_id").references(() => priceQuotes.id),
    labAnalysisId: uuid("lab_analysis_id"),

    grossAmountD: bigint("gross_amount_d", { mode: "number" }).notNull(),
    advanceOffsetD: bigint("advance_offset_d", { mode: "number" }).notNull(),
    cashPayableD: bigint("cash_payable_d", { mode: "number" }).notNull(),

    /** Invoice number printed for the farmer. */
    invoiceNo: text("invoice_no").notNull(),
    ledgerTxId: uuid("ledger_tx_id")
      .notNull()
      .references(() => ledgerTx.id),

    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    paidBy: uuid("paid_by")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    /** Whether the physical stamped Copy C was collected. Recorded, not assumed. */
    copyCollected: boolean("copy_collected").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    // The one constraint that makes double payment impossible.
    uniqueIndex("payments_ticket_idx").on(t.ticketId),
    uniqueIndex("payments_client_uuid_idx").on(t.clientUuid),
    uniqueIndex("payments_invoice_idx").on(t.invoiceNo),
    index("payments_counterparty_idx").on(t.counterpartyId),
    index("payments_paid_at_idx").on(t.paidAt),
  ],
);

/**
 * Пардохти нақдӣ — one handful of cash actually leaving the drawer for one farm.
 *
 * Settlement (`payments`) fixes what the factory owes; this records what it has since
 * handed over. A farm that settles a 6 000-сомонӣ борхат and takes 2 000 today has one
 * payment row and one disbursement row, and comes back for the rest — which is the second
 * disbursement row. Kept apart from `payments` on purpose: a settlement happens once per
 * ticket and is bound to a price and a lab result, while a disbursement happens any number
 * of times, is bound to nothing but the farm, and may be zero-count for weeks.
 *
 * docs/domain.md §4.
 */
export const disbursements = pgTable(
  "disbursements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Idempotency key from the cash desk. Replaying it returns the original row. */
    clientUuid: uuid("client_uuid").notNull(),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id),
    /**
     * The settlement this cash was handed over against, when the cashier paid at the
     * moment of settling. Null for a later instalment, which is paid against the farm's
     * balance as a whole rather than against any one борхат.
     */
    paymentId: uuid("payment_id").references(() => payments.id),

    amountD: bigint("amount_d", { mode: "number" }).notNull(),
    /** The farm's outstanding balance after this disbursement — printed on the receipt. */
    balanceAfterD: bigint("balance_after_d", { mode: "number" }).notNull(),

    receiptNo: text("receipt_no").notNull(),
    ledgerTxId: uuid("ledger_tx_id")
      .notNull()
      .references(() => ledgerTx.id),

    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    paidBy: uuid("paid_by")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    uniqueIndex("disbursements_client_uuid_idx").on(t.clientUuid),
    uniqueIndex("disbursements_receipt_idx").on(t.receiptNo),
    index("disbursements_counterparty_idx").on(t.counterpartyId),
    index("disbursements_payment_idx").on(t.paymentId),
    index("disbursements_paid_at_idx").on(t.paidAt),
  ],
);

// ------------------------------------------------------------------ operating expenses

/**
 * Харочот — a category of factory cost that is not cotton itself: маош (payroll),
 * маҳсулот барои ошхона (kitchen supplies), таъмири корхона (maintenance), and whatever
 * else the owner names. A real table rather than a fixed list, so a new category is one
 * row, not a code change and a redeploy.
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    nameTg: text("name_tg").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("expense_categories_name_idx").on(t.nameTg)],
);

/**
 * One factory expense: cash out for something that is not cotton. Every row posts the
 * same ledger shape (Dr OPERATING_EXPENSE / Cr CASH, see `buildOperatingExpenseTx`) —
 * the category lives here, not as a separate ledger account per category, so "how much
 * on payroll this season" is one query against this table and the trial balance stays
 * one line.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    amountD: bigint("amount_d", { mode: "number" }).notNull(),
    note: text("note"),
    ledgerTxId: uuid("ledger_tx_id")
      .notNull()
      .references(() => ledgerTx.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
  },
  (t) => [
    uniqueIndex("expenses_client_uuid_idx").on(t.clientUuid),
    index("expenses_category_idx").on(t.categoryId),
    index("expenses_occurred_idx").on(t.occurredAt),
  ],
);
