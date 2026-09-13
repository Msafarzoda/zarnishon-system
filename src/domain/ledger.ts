import { DomainError, assertNonNegativeInt, assertSafeInt } from "./units.js";
import type { Settlement } from "./settlement.js";

/**
 * Double-entry posting rules. Every transaction this module builds is balanced by
 * construction and checked before it is returned, so an unbalanced transaction can
 * never reach the database.
 *
 * Sign convention: **debit positive, credit negative**. Entries of one transaction
 * sum to zero.
 *
 *   CASH                — хазина, a physical drawer            (asset,  debit-normal)
 *   BANK                                                        (asset,  debit-normal)
 *   ADVANCE_RECEIVABLE  — қарз a farm owes us, one per farm    (asset,  debit-normal)
 *   COTTON_PURCHASE     — what we paid for cotton              (expense, debit-normal)
 *   SEED_REVENUE        — cottonseed sold to oil factories     (income, credit-normal)
 *   OPENING_BALANCE     — used only to open the books          (equity, credit-normal)
 */

export type LedgerTxKind =
  | "ADVANCE_ISSUED"
  | "ADVANCE_REPAID_CASH"
  | "COTTON_PAYMENT"
  | "SEED_SALE_RECEIPT"
  | "CASH_OPENING"
  | "CASH_ADJUSTMENT"
  | "REVERSAL";

export interface DraftEntry {
  accountId: string;
  /** Signed diram: debit positive, credit negative. */
  amountD: number;
}

export interface DraftTx {
  kind: LedgerTxKind;
  memo: string;
  entries: DraftEntry[];
}

/** Throws unless the entries sum to zero and none is a no-op. */
export function assertBalanced(tx: DraftTx): DraftTx {
  if (tx.entries.length < 2) {
    throw new DomainError(`Transaction "${tx.memo}" needs at least two entries.`);
  }
  let sum = 0;
  for (const e of tx.entries) {
    assertSafeInt(e.amountD, "entry.amountD");
    if (e.amountD === 0) {
      throw new DomainError(`Transaction "${tx.memo}" contains a zero-amount entry.`);
    }
    sum += e.amountD;
  }
  if (sum !== 0) {
    throw new DomainError(
      `Transaction "${tx.memo}" does not balance: entries sum to ${sum} diram, expected 0.`,
    );
  }
  return tx;
}

export interface CottonPaymentAccounts {
  cashAccountId: string;
  cottonPurchaseAccountId: string;
  /** The farm's advance account. Required whenever an advance is being recovered. */
  advanceAccountId?: string;
}

/**
 * Paying a farmer for one ticket.
 *
 *   Dr COTTON_PURCHASE     gross_amount_d
 *     Cr CASH                             cash_payable_d
 *     Cr ADVANCE_RECEIVABLE               advance_offset_d
 *
 * The advance recovered never leaves the drawer — that is exactly why the cash credit is
 * only the part actually handed over, and why the two credits must add back to the gross.
 */
export function buildCottonPaymentTx(
  settlement: Settlement,
  accounts: CottonPaymentAccounts,
  memo: string,
): DraftTx {
  const { grossAmountD, cashPayableD, advanceOffsetD } = settlement;
  assertNonNegativeInt(grossAmountD, "grossAmountD");
  assertNonNegativeInt(cashPayableD, "cashPayableD");
  assertNonNegativeInt(advanceOffsetD, "advanceOffsetD");

  if (cashPayableD + advanceOffsetD !== grossAmountD) {
    throw new DomainError(
      `Settlement is internally inconsistent: cash ${cashPayableD} + advance ${advanceOffsetD} ` +
        `!= gross ${grossAmountD}.`,
    );
  }
  if (grossAmountD === 0) {
    throw new DomainError("Nothing to pay: the settlement amounts to zero.");
  }
  if (advanceOffsetD > 0 && !accounts.advanceAccountId) {
    throw new DomainError(
      "An advance is being recovered but no advance account was supplied for this farm.",
    );
  }

  const entries: DraftEntry[] = [{ accountId: accounts.cottonPurchaseAccountId, amountD: grossAmountD }];
  if (cashPayableD > 0) {
    entries.push({ accountId: accounts.cashAccountId, amountD: -cashPayableD });
  }
  if (advanceOffsetD > 0) {
    entries.push({ accountId: accounts.advanceAccountId!, amountD: -advanceOffsetD });
  }

  return assertBalanced({ kind: "COTTON_PAYMENT", memo, entries });
}

/**
 * Handing a farm cash before it sells — money to pay the pickers.
 *
 *   Dr ADVANCE_RECEIVABLE  principal
 *     Cr CASH                          principal
 */
export function buildAdvanceIssuedTx(
  principalD: number,
  accounts: { cashAccountId: string; advanceAccountId: string },
  memo: string,
): DraftTx {
  assertNonNegativeInt(principalD, "principalD");
  if (principalD === 0) throw new DomainError("An advance of zero cannot be issued.");
  return assertBalanced({
    kind: "ADVANCE_ISSUED",
    memo,
    entries: [
      { accountId: accounts.advanceAccountId, amountD: principalD },
      { accountId: accounts.cashAccountId, amountD: -principalD },
    ],
  });
}

/** A farm repaying an advance in cash instead of in cotton. */
export function buildAdvanceRepaidCashTx(
  amountD: number,
  accounts: { cashAccountId: string; advanceAccountId: string },
  memo: string,
): DraftTx {
  assertNonNegativeInt(amountD, "amountD");
  if (amountD === 0) throw new DomainError("A repayment of zero cannot be recorded.");
  return assertBalanced({
    kind: "ADVANCE_REPAID_CASH",
    memo,
    entries: [
      { accountId: accounts.cashAccountId, amountD },
      { accountId: accounts.advanceAccountId, amountD: -amountD },
    ],
  });
}

/**
 * Cottonseed sold to an oil factory, cash received.
 *
 *   Dr CASH        amount
 *     Cr SEED_REVENUE     amount
 */
export function buildSeedSaleReceiptTx(
  amountD: number,
  accounts: { cashAccountId: string; seedRevenueAccountId: string },
  memo: string,
): DraftTx {
  assertNonNegativeInt(amountD, "amountD");
  if (amountD === 0) throw new DomainError("A seed sale of zero cannot be recorded.");
  return assertBalanced({
    kind: "SEED_SALE_RECEIPT",
    memo,
    entries: [
      { accountId: accounts.cashAccountId, amountD },
      { accountId: accounts.seedRevenueAccountId, amountD: -amountD },
    ],
  });
}

/**
 * Undo a posted transaction by posting its mirror image. The original stays in the
 * ledger for ever; this is the only way anything is ever "corrected".
 */
export function buildReversalTx(original: DraftTx, reason: string): DraftTx {
  if (!reason.trim()) {
    throw new DomainError("A reversal requires a reason.");
  }
  return assertBalanced({
    kind: "REVERSAL",
    memo: `Реверс: ${original.memo} — ${reason}`,
    entries: original.entries.map((e) => ({ accountId: e.accountId, amountD: -e.amountD })),
  });
}

/**
 * Cash on hand, a farm's outstanding advance, any balance at all: always the sum of the
 * entries. Nothing in this system stores a balance that a person can type over.
 */
export function balanceOf(entries: readonly DraftEntry[], accountId: string): number {
  return entries.reduce((sum, e) => (e.accountId === accountId ? sum + e.amountD : sum), 0);
}
