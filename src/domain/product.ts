import { DomainError, GRAMS_PER_KG, assertNonNegativeInt, divRound } from "./units";

/**
 * Маҳсулот — what comes out of the gin, and what it is worth. docs/domain.md §7.
 *
 * Three of the four products are heaps: чигит, улюк and пучоқ are weighed by lorry on the
 * way out, тара then брутто, and sold by the kilogram. The fourth, кип, is a stack of
 * numbered objects, and everything different about it follows from that one fact.
 */

export type ProductKind = "chigit" | "kip" | "ulyuk" | "puchoq";

export const PRODUCT_KINDS: readonly ProductKind[] = ["chigit", "kip", "ulyuk", "puchoq"];

/**
 * Whether this product leaves by the weighbridge.
 *
 * Кип does not, and not as a convenience: each bale was weighed at the press and carries
 * that weight for life, so a trailer of them is the sum of what was scanned onto it. Take
 * a брутто of a bale lorry instead and you get a second, disagreeing number for cotton
 * that has already been counted in a run's mass balance.
 */
export function isBulk(product: ProductKind): boolean {
  return product !== "kip";
}

// ---------------------------------------------------------------- bale serials

/**
 * The serial a bale carries for life, and what its barcode encodes.
 *
 *     K-2026-101-00042      season 2026, партия 101, the 42nd bale of that партия
 *
 * The партия is **in** the serial because that is how the warehouse talks about a bale —
 * "the 101s are under the far навес". A serial that only counted bales would be unique and
 * useless: the one question asked of a bale standing in a shed is where it came from, and
 * a person holding it should be able to answer that without a scanner.
 *
 * Numbered within its партия rather than across the season, so the count on the label
 * ("42 of партия 101") means something on its own.
 */
export function baleSerial(season: number, batchNumber: number, n: number): string {
  assertNonNegativeInt(season, "season");
  assertNonNegativeInt(batchNumber, "batchNumber");
  if (n < 1) throw new DomainError(`A bale number starts at 1, got ${n}`);
  return `K-${season}-${batchNumber}-${String(n).padStart(5, "0")}`;
}

export interface ParsedBaleSerial {
  season: number;
  batchNumber: number;
  n: number;
}

/**
 * Reads a serial back, whether it was scanned, typed, or typed in lower case with the
 * spaces a person puts in when reading digits off a label aloud.
 *
 * Returns null rather than throwing: at the loading bay an unrecognised scan is an
 * ordinary event — a pallet label, a buyer's own sticker, the scanner firing at nothing —
 * and it must produce "that is not one of ours", not a crash.
 */
export function parseBaleSerial(input: string): ParsedBaleSerial | null {
  const text = input.trim().toUpperCase().replace(/\s+/g, "");
  const m = /^K-(\d{4})-(\d{1,6})-(\d{1,6})$/.exec(text);
  if (!m) return null;
  return { season: Number(m[1]), batchNumber: Number(m[2]), n: Number(m[3]) };
}

// ---------------------------------------------------------------- money

/**
 * What a weight of product is worth at a price.
 *
 * Same integer rounding as every other money figure in the system: grams × diram/kg,
 * divided by 1 000, rounded half away from zero. Never a floating-point multiply — the
 * same expression evaluated twice must give the same сомонӣ, on the invoice and in the
 * ledger.
 */
export function saleAmountD(weightG: number, priceDPerKg: number): number {
  assertNonNegativeInt(weightG, "weightG");
  assertNonNegativeInt(priceDPerKg, "priceDPerKg");
  return divRound(weightG * priceDPerKg, GRAMS_PER_KG);
}

/**
 * Брутто − тара for a lorry that came to collect, with the checks that make the answer
 * trustworthy rather than merely arithmetical.
 *
 * Outbound is intake mirrored: the lorry arrives empty, so тара is taken first and брутто
 * after loading, and брутто below тара means somebody weighed in the wrong order — which
 * is a question for the operator, not a negative sale.
 */
export function bulkNetG(tareG: number, grossG: number): number {
  assertNonNegativeInt(tareG, "tareG");
  assertNonNegativeInt(grossG, "grossG");
  if (grossG <= tareG) {
    throw new DomainError(
      "Брутто бояд аз тара зиёд бошад. / Gross must exceed tare — the lorry left no heavier " +
        "than it arrived.",
    );
  }
  return grossG - tareG;
}
