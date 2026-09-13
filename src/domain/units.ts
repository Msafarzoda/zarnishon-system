/**
 * Integer-only unit handling. No floating point ever touches a weight or an amount.
 *
 *   weight  -> grams            (`_g`)      1 kg      = 1_000 g
 *   money   -> diram            (`_d`)      1 сомонӣ  = 100 diram
 *   percent -> basis points     (`_bp`)     1 %       = 100 bp
 *   price   -> diram per kg     (`_d_per_kg`)
 */

/** Largest value we allow through the integer math, well inside Number.MAX_SAFE_INTEGER. */
const SAFE_MAX = 2 ** 48; // ~2.8e14

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export function assertSafeInt(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new DomainError(`${label} must be an integer, got ${value}`);
  }
  if (Math.abs(value) > SAFE_MAX) {
    throw new DomainError(`${label} is out of safe range: ${value}`);
  }
  return value;
}

export function assertNonNegativeInt(value: number, label: string): number {
  assertSafeInt(value, label);
  if (value < 0) throw new DomainError(`${label} must not be negative, got ${value}`);
  return value;
}

/**
 * Integer division rounding half away from zero.
 * Used for every money and weight conversion so rounding is explicit and symmetric.
 */
export function divRound(numerator: number, denominator: number): number {
  assertSafeInt(numerator, "numerator");
  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new DomainError(`denominator must be a positive integer, got ${denominator}`);
  }
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  return sign * Math.floor((2 * abs + denominator) / (2 * denominator));
}

// ---------------------------------------------------------------- weight

export const GRAMS_PER_KG = 1000;

/** "3015" or "3015.5" kilograms as typed by an operator -> integer grams. */
export function kgStringToGrams(input: string): number {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(text)) {
    throw new DomainError(`Invalid kilogram value: "${input}"`);
  }
  const [whole = "0", frac = ""] = text.split(".");
  const millis = (frac + "000").slice(0, 3);
  return Number(whole) * GRAMS_PER_KG + Number(millis);
}

/**
 * Grams -> display string in kilograms at the requested precision.
 *
 * Rounds rather than truncates: 628 650 g shown to one decimal is 628.7 kg, not 628.6.
 * This string is what a farmer reads on his printed Борхат, so it must not quietly
 * round against him. The underlying grams are never changed — only what is displayed.
 */
export function gramsToKgString(grams: number, decimals = 3): string {
  assertSafeInt(grams, "grams");
  const places = Math.min(3, Math.max(0, Math.trunc(decimals)));
  const sign = grams < 0 ? "-" : "";

  // Round to the last displayed digit before splitting into whole and fraction.
  const step = 10 ** (3 - places);
  const abs = divRound(Math.abs(grams), step) * step;

  const whole = Math.floor(abs / GRAMS_PER_KG);
  const frac = String(abs % GRAMS_PER_KG).padStart(3, "0");
  if (places === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.slice(0, places)}`;
}

// ---------------------------------------------------------------- money

export const DIRAM_PER_SOMONI = 100;

/** "12.50" сомонӣ as typed -> integer diram. */
export function somoniStringToDiram(input: string): number {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
    throw new DomainError(`Invalid somoni value: "${input}"`);
  }
  const [whole = "0", frac = ""] = text.split(".");
  const cents = (frac + "00").slice(0, 2);
  return Number(whole) * DIRAM_PER_SOMONI + Number(cents);
}

/** Diram -> "1 234.50" for display. */
export function diramToSomoniString(diram: number): string {
  assertSafeInt(diram, "diram");
  const sign = diram < 0 ? "-" : "";
  const abs = Math.abs(diram);
  const whole = Math.floor(abs / DIRAM_PER_SOMONI);
  const frac = String(abs % DIRAM_PER_SOMONI).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped}.${frac}`;
}

// ---------------------------------------------------------------- percent

export const BP_PER_PERCENT = 100;
export const BP_FULL = 10_000; // 100 %

/** "1.5" percent as typed -> basis points. */
export function percentStringToBp(input: string): number {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
    throw new DomainError(`Invalid percent value: "${input}"`);
  }
  const [whole = "0", frac = ""] = text.split(".");
  const hundredths = (frac + "00").slice(0, 2);
  const bp = Number(whole) * BP_PER_PERCENT + Number(hundredths);
  if (bp > BP_FULL) throw new DomainError(`Percent may not exceed 100 %, got "${input}"`);
  return bp;
}

export function bpToPercentString(bp: number, decimals = 2): string {
  assertSafeInt(bp, "bp");
  const sign = bp < 0 ? "-" : "";
  const abs = Math.abs(bp);
  const whole = Math.floor(abs / BP_PER_PERCENT);
  const frac = String(abs % BP_PER_PERCENT).padStart(2, "0");
  if (decimals <= 0) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.slice(0, decimals)}`;
}
