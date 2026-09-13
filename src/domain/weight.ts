import { BP_FULL, DomainError, assertNonNegativeInt, divRound } from "./units.js";

/**
 * Нетто = Брутто − Тара
 *
 * Gross is the loaded truck on the weighbridge, tare the same truck after unloading.
 * The difference is the cotton we actually received.
 */
export function netWeight(grossG: number, tareG: number): number {
  assertNonNegativeInt(grossG, "grossG");
  assertNonNegativeInt(tareG, "tareG");
  if (tareG >= grossG) {
    throw new DomainError(
      `Tare (${tareG} g) must be less than gross (${grossG} g) — the truck cannot weigh ` +
        `at least as much empty as loaded. Check which weighing is which.`,
    );
  }
  return grossG - tareG;
}

// ---------------------------------------------------------------- lab deduction

/** How the lab's moisture and trash readings turn into a weight deduction. */
export type DeductionMode = "TOTAL" | "EXCESS_OVER_NORM";

export interface LabReading {
  /** Влажность, basis points */
  moistureBp: number;
  /** Засорённость, basis points */
  trashBp: number;
}

export interface DeductionNorms {
  /** Contract moisture norm; only the excess above this is deducted in EXCESS_OVER_NORM. */
  moistureBp: number;
  /** Contract trash norm. */
  trashBp: number;
}

/**
 * TOTAL            — deduct the full measured moisture + trash.
 * EXCESS_OVER_NORM — deduct only what exceeds the contract norms (industry standard).
 *
 * See docs/domain.md §3: which mode applies is an owner decision, not a code decision.
 */
export function deductionBp(
  reading: LabReading,
  mode: DeductionMode,
  norms: DeductionNorms,
): number {
  assertNonNegativeInt(reading.moistureBp, "moistureBp");
  assertNonNegativeInt(reading.trashBp, "trashBp");
  assertNonNegativeInt(norms.moistureBp, "norms.moistureBp");
  assertNonNegativeInt(norms.trashBp, "norms.trashBp");

  const raw =
    mode === "TOTAL"
      ? reading.moistureBp + reading.trashBp
      : Math.max(0, reading.moistureBp - norms.moistureBp) +
        Math.max(0, reading.trashBp - norms.trashBp);

  if (raw >= BP_FULL) {
    throw new DomainError(
      `Deduction of ${raw} bp would leave nothing payable. Re-check the analysis.`,
    );
  }
  return raw;
}

/**
 * Payable (conditioned) weight after the lab deduction.
 *
 *   payable_g = net_g × (10000 − deduction_bp) / 10000
 */
export function payableWeight(netG: number, deduction: number): number {
  assertNonNegativeInt(netG, "netG");
  assertNonNegativeInt(deduction, "deductionBp");
  if (deduction >= BP_FULL) {
    throw new DomainError(`deductionBp must be below 100 %, got ${deduction}`);
  }
  return divRound(netG * (BP_FULL - deduction), BP_FULL);
}
