import { pgEnum } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", [
  "guard", // посбон
  "weigher", // тарозубон
  "lab", // лаборант
  "merchandiser", // молшинос
  "cashier", // хазинадор
  "accountant", // муҳосиб
  "owner", // соҳиб
  "admin",
]);

export const counterpartyKind = pgEnum("counterparty_kind", [
  "farm", // хоҷагӣ — consignor of cotton
  "individual", // private grower / driver selling his own cotton
  "company", // e.g. an oil factory buying seed
]);

export const ticketStatus = pgEnum("ticket_status", [
  "DRAFT",
  "OPEN",
  "WEIGHED",
  "ANALYSED",
  "PAID",
  "VOID",
]);

export const gateState = pgEnum("gate_state", [
  "ARRIVED",
  "WEIGHED_GROSS",
  "UNLOADING",
  "WEIGHED_TARE",
  "DEPARTED",
]);

/** Which weighing this event is, and whether it replaces an earlier one. */
export const weighKind = pgEnum("weigh_kind", ["GROSS", "TARE"]);

/** Where the number came from. `indicator` is reserved for the direct weighbridge feed. */
export const weighSource = pgEnum("weigh_source", ["manual", "indicator"]);

export const storageKind = pgEnum("storage_kind", [
  "sklad", // анбор / склад
  "bunt", // бунт — open stack
  "naves", // навес — shed
]);

/** Which measurement point on Форма №9-хл an analysis represents. */
export const analysisStage = pgEnum("analysis_stage", ["on_intake", "on_dispatch"]);

export const analysisStatus = pgEnum("analysis_status", ["DRAFT", "APPROVED", "SUPERSEDED"]);

/** How the lab reading becomes a weight deduction. See docs/domain.md §3. */
export const deductionMode = pgEnum("deduction_mode", ["TOTAL", "EXCESS_OVER_NORM"]);

export const accountKind = pgEnum("account_kind", [
  "CASH", // хазина — a physical cash drawer
  "BANK",
  "ADVANCE_RECEIVABLE", // қарз owed to us by one farm
  "FARM_PAYABLE", // settled cotton money we still owe one farm
  "COTTON_PURCHASE", // expense
  "SEED_REVENUE", // income from cottonseed sales
  "OPENING_BALANCE", // equity, used only to open the books
]);

export const ledgerTxKind = pgEnum("ledger_tx_kind", [
  "ADVANCE_ISSUED",
  "ADVANCE_REPAID_CASH",
  "COTTON_PAYMENT",
  "CASH_DISBURSEMENT",
  "SEED_SALE_RECEIPT",
  "CASH_OPENING",
  "CASH_ADJUSTMENT",
  "REVERSAL",
]);
