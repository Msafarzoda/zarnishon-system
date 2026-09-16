import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { priceQuotes } from "@/db/schema/index";

export interface ResolvedPrice {
  priceQuoteId: string;
  priceDPerKg: number;
  effectiveFrom: Date;
}

/**
 * Нархи рӯзи пардохт — the price in force on the day of payment, not the day of intake.
 * A farmer who keeps his stamped copy is speculating on price; this is where that pays
 * off or doesn't. docs/domain.md §4.
 *
 * A quote that names a variety beats a general one for the same date.
 */
export async function resolvePriceAt(
  at: Date,
  varietyId: string | null,
  /** Pass the transaction handle when called inside one. See balances.ts on why. */
  x: Pick<typeof db, "select"> = db,
): Promise<ResolvedPrice> {
  const rows = await x
    .select()
    .from(priceQuotes)
    .where(
      and(
        lte(priceQuotes.effectiveFrom, at),
        or(isNull(priceQuotes.effectiveTo), gte(priceQuotes.effectiveTo, at)),
        varietyId
          ? or(eq(priceQuotes.varietyId, varietyId), isNull(priceQuotes.varietyId))
          : isNull(priceQuotes.varietyId),
      ),
    )
    .orderBy(desc(priceQuotes.effectiveFrom));

  // Prefer the variety-specific quote among those effective on this date.
  const specific = rows.find((r) => varietyId !== null && r.varietyId === varietyId);
  const chosen = specific ?? rows[0];

  if (!chosen) {
    throw new Error(
      `Нарх барои ${at.toISOString().slice(0, 10)} муқаррар нашудааст. / ` +
        `No purchase price is in force for this date — the owner must set one.`,
    );
  }
  return {
    priceQuoteId: chosen.id,
    priceDPerKg: chosen.priceDPerKg,
    effectiveFrom: chosen.effectiveFrom,
  };
}
