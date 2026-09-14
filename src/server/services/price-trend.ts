import { and, desc, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { priceQuotes } from "@/db/schema/index";

/**
 * What the price has done lately.
 *
 * A farmer does not have to be paid the day he delivers. He keeps his stamped copy and
 * comes back when the price suits him, and whatever it is that day is what he gets. So
 * the one fact both sides of the desk need is which way the price has moved — otherwise
 * the cashier cannot answer the only question the farmer ever asks, and the farm is
 * deciding blind.
 */

export interface PriceTrend {
  /** The price in force today, or null if the owner has never set one. */
  currentD: number | null;
  /** The price before the current one, and when the current one took effect. */
  previousD: number | null;
  changedAt: Date | null;
  /** Signed difference in diram; null when there is nothing to compare against. */
  changeD: number | null;
}

export async function priceTrend(at = new Date()): Promise<PriceTrend> {
  // General quotes only: this is the headline price the owner sets for the day, which is
  // what a farmer waiting for "a good price" is watching.
  const quotes = await db
    .select({
      priceDPerKg: priceQuotes.priceDPerKg,
      effectiveFrom: priceQuotes.effectiveFrom,
    })
    .from(priceQuotes)
    .where(
      and(
        isNull(priceQuotes.varietyId),
        lte(priceQuotes.effectiveFrom, at),
        or(isNull(priceQuotes.effectiveTo), gte(priceQuotes.effectiveTo, at)),
      ),
    )
    .orderBy(desc(priceQuotes.effectiveFrom))
    .limit(8);

  const current = quotes[0];
  if (!current) return { currentD: null, previousD: null, changedAt: null, changeD: null };

  // Walk back to the last quote that was actually a different number — re-entering the
  // same price is not a change and should not be reported as one.
  const previous = quotes.find((q) => q.priceDPerKg !== current.priceDPerKg);

  return {
    currentD: current.priceDPerKg,
    previousD: previous?.priceDPerKg ?? null,
    changedAt: previous ? current.effectiveFrom : null,
    changeD: previous ? current.priceDPerKg - previous.priceDPerKg : null,
  };
}
