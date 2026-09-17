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
  "local", // a neighbour buying a lorry of чигит or пучоқ for cash, no ТИН
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
  "SEED_REVENUE", // income from cottonseed sales — kept for books opened before §7
  "PRODUCT_REVENUE", // income from чигит, улюк, пучоқ and кип alike
  "BUYER_RECEIVABLE", // a buyer who has taken the goods and not yet paid, one per buyer
  "OPENING_BALANCE", // equity, used only to open the books
  "OPERATING_EXPENSE", // маош ва харочоти корхона — wages and other non-cotton factory costs
]);

export const ledgerTxKind = pgEnum("ledger_tx_kind", [
  "ADVANCE_ISSUED",
  "ADVANCE_REPAID_CASH",
  "COTTON_PAYMENT",
  "CASH_DISBURSEMENT",
  "SEED_SALE_RECEIPT",
  "PRODUCT_SALE_CREDIT", // goods left the yard, the money has not arrived
  "SALE_PAYMENT_RECEIVED", // the buyer paid — cash into the same drawer that buys cotton
  "CASH_OPENING",
  "CASH_ADJUSTMENT",
  "OPERATING_EXPENSE", // маош ва харочоти корхона — wages and other non-cotton factory costs
  "REVERSAL",
]);


// ------------------------------------------------------------------ phase 2

/**
 * What leaves the factory. docs/domain.md §7.
 *
 * Чигит, улюк and пучоқ leave by the weighbridge, брутто and тара, like intake mirrored.
 * Кип does not: each bale was weighed when it was pressed and carries that weight for
 * life, so a lorry-load of them is the sum of what was scanned onto it.
 */
export const productKind = pgEnum("product_kind", [
  "chigit", // чигит — cottonseed, to the oil factories, ~57 %
  "kip", // кип — pressed lint bales, ~33 %, sold at the end of the season
  "ulyuk", // улюк — ~1 %, sold, or fed back through the machines
  "puchoq", // пучоқ — leaves, dust and trash
]);

/** Which way a lorry is being weighed. docs/domain.md §7. */
export const weighDirection = pgEnum("weigh_direction", [
  /** Пахта arriving: loaded on arrival, so БРУТТО first, ТАРА after unloading. */
  "inbound",
  /** Product leaving: empty on arrival, so ТАРА first, БРУТТО after loading. */
  "outbound",
]);

/**
 * A bale's life. Pressed, stored for most of the year, then sold.
 *
 * REPRESSED is not a dead end: a bale that has to be opened and pressed again keeps its
 * record, because the lint in it was still counted in a production run's balance and must
 * not vanish from it.
 */
export const baleState = pgEnum("bale_state", [
  "IN_STOCK",
  "SHIPPED",
  "SOLD",
  "REPRESSED",
  "VOID",
]);

/** Cotton fed into the gin is either bought from a farm or improved улюк coming back. */
export const feedSource = pgEnum("feed_source", [
  /** From a бунт — cotton the factory paid a farm for. Only this counts towards yield. */
  "primary",
  /** Улюк from an earlier run. Counting it as input again inflates throughput. */
  "recycled",
]);
