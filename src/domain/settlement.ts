import { GRAMS_PER_KG, assertNonNegativeInt, divRound } from "./units";
import { payableWeight } from "./weight";

export interface SettlementInput {
  /** Нетто from the weighbridge, grams. */
  netG: number;
  /** Deduction from the approved lab analysis, basis points. */
  deductionBp: number;
  /**
   * Price in force **on the day of payment** — not the day of intake.
   * A farmer who waits is speculating on price; that is the whole point. docs/domain.md §4.
   */
  priceDPerKg: number;
  /** The farm's outstanding advance balance before this settlement, diram. */
  outstandingAdvanceD: number;
}

export interface Settlement {
  netG: number;
  deductionBp: number;
  /** Weight actually paid for, after the lab deduction. */
  payableG: number;
  priceDPerKg: number;
  /** What the cotton is worth before any advance is recovered. */
  grossAmountD: number;
  /** Advance recovered from this settlement. */
  advanceOffsetD: number;
  /** Cash handed to the farmer. */
  cashPayableD: number;
  /** Advance still owed by the farm after this settlement. */
  remainingAdvanceD: number;
}

/**
 * Settle one ticket.
 *
 *   payable_g      = net_g × (10000 − deduction_bp) / 10000
 *   gross_amount_d = payable_g × price_d_per_kg / 1000
 *   offset_d       = min(outstanding_advance_d, gross_amount_d)
 *   cash_payable_d = gross_amount_d − offset_d
 *
 * An advance larger than this ticket is only partly recovered; the rest stays
 * outstanding against the farm's future deliveries. We never hand back a negative.
 */
export function settleTicket(input: SettlementInput): Settlement {
  const netG = assertNonNegativeInt(input.netG, "netG");
  const priceDPerKg = assertNonNegativeInt(input.priceDPerKg, "priceDPerKg");
  const outstandingAdvanceD = assertNonNegativeInt(
    input.outstandingAdvanceD,
    "outstandingAdvanceD",
  );

  const payableG = payableWeight(netG, input.deductionBp);
  const grossAmountD = divRound(payableG * priceDPerKg, GRAMS_PER_KG);
  const advanceOffsetD = Math.min(outstandingAdvanceD, grossAmountD);

  return {
    netG,
    deductionBp: input.deductionBp,
    payableG,
    priceDPerKg,
    grossAmountD,
    advanceOffsetD,
    cashPayableD: grossAmountD - advanceOffsetD,
    remainingAdvanceD: outstandingAdvanceD - advanceOffsetD,
  };
}
