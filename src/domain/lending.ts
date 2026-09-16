import { GRAMS_PER_KG, assertNonNegativeInt, divRound } from "./units";

/**
 * Қарз — how much a farm may borrow.
 *
 * Nothing is lent without cotton behind it. The limit is a flat rate per kilogram of the
 * farm's own cotton sitting in our warehouse and not yet settled for, and the rate is set
 * by the owner. docs/domain.md §4.
 *
 * The raw нетто is used, not the payable weight the lab would leave: this is a lending
 * limit, not a valuation. The whole margin between the collateral rate and what the cotton
 * is actually worth is what makes the loan safe — deducting moisture on top of that would
 * make the cap arbitrary without making it safer.
 */
export interface Collateral {
  /** Нетто of everything this farm has delivered and not yet settled, grams. */
  cottonInHandG: number;
  /** The most this farm could owe us at once, diram. */
  maxAdvanceD: number;
  /** What it already owes, diram. */
  outstandingD: number;
  /** What it may still borrow today, diram. Never negative. */
  headroomD: number;
  /** True when past advances already exceed the cotton standing behind them. */
  overLent: boolean;
}

export function collateralFor(args: {
  cottonInHandG: number;
  outstandingAdvanceD: number;
  advanceRateDPerKg: number;
}): Collateral {
  const cottonInHandG = assertNonNegativeInt(args.cottonInHandG, "cottonInHandG");
  const outstandingD = assertNonNegativeInt(args.outstandingAdvanceD, "outstandingAdvanceD");
  const rate = assertNonNegativeInt(args.advanceRateDPerKg, "advanceRateDPerKg");

  const maxAdvanceD = divRound(cottonInHandG * rate, GRAMS_PER_KG);

  return {
    cottonInHandG,
    maxAdvanceD,
    outstandingD,
    headroomD: Math.max(0, maxAdvanceD - outstandingD),
    // Cotton can leave the collateral pool — it gets settled — while a loan stays put.
    // That is not an error, but it is a thing the owner should be able to see.
    overLent: outstandingD > maxAdvanceD,
  };
}
