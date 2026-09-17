import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, productPrices, users } from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { PRODUCT_KINDS, type ProductKind } from "@/domain/product";
import { tgProduct } from "@/lib/i18n/products";

/**
 * Нархи маҳсулот — what the owner says a kilogram of product sells for today.
 *
 * The same shape as the cotton price in §4 and for the same reason: effective-dated,
 * insert-only, and read as "the latest quote not later than this moment". A sale carries
 * the price it was made at for ever, so moving the price tomorrow cannot reprice
 * yesterday's lorry.
 */

export interface ResolvedProductPrice {
  productPriceId: string;
  priceDPerKg: number;
  effectiveFrom: Date;
}

export async function resolveProductPriceAt(
  product: ProductKind,
  at: Date = new Date(),
  x: Pick<typeof db, "select"> = db,
): Promise<ResolvedProductPrice> {
  const [row] = await x
    .select()
    .from(productPrices)
    .where(and(eq(productPrices.product, product), lte(productPrices.effectiveFrom, at)))
    .orderBy(desc(productPrices.effectiveFrom))
    .limit(1);

  if (!row) {
    throw new DomainError(
      `Нархи «${tgProduct[product]}» муқаррар нашудааст — соҳиб бояд нарх гузорад. / ` +
        `No selling price has been set for ${product}; only the owner can set one.`,
    );
  }
  return {
    productPriceId: row.id,
    priceDPerKg: row.priceDPerKg,
    effectiveFrom: row.effectiveFrom,
  };
}

/**
 * Every product's current price at once, for a screen that has to show what can be sold
 * and what cannot. A product with no price yet is `null` rather than an exception — the
 * sales screen's job is to say "the owner has not priced улюк", not to fail to load.
 */
export async function currentProductPrices(
  at: Date = new Date(),
): Promise<Record<ProductKind, ResolvedProductPrice | null>> {
  const out = {} as Record<ProductKind, ResolvedProductPrice | null>;
  for (const product of PRODUCT_KINDS) {
    try {
      out[product] = await resolveProductPriceAt(product, at);
    } catch {
      out[product] = null;
    }
  }
  return out;
}

export interface SetProductPriceInput {
  product: ProductKind;
  priceDPerKg: number;
  effectiveFrom?: Date;
  setBy: string;
  note?: string;
}

/** Only the owner reaches this — enforced by the route, and checked again here. */
export async function setProductPrice(input: SetProductPriceInput) {
  if (!Number.isSafeInteger(input.priceDPerKg) || input.priceDPerKg <= 0) {
    throw new DomainError("Нарх бояд аз сифр зиёд бошад. / The price must be above zero.");
  }

  const [setter] = await db
    .select({ role: users.role, extraRoles: users.extraRoles })
    .from(users)
    .where(eq(users.id, input.setBy))
    .limit(1);
  const held = [setter?.role, ...(setter?.extraRoles ?? [])];
  if (!held.includes("owner")) {
    throw new DomainError(
      "Танҳо соҳиби корхона нарх мегузорад. / Only the owner sets prices.",
    );
  }

  const [row] = await db
    .insert(productPrices)
    .values({
      product: input.product,
      priceDPerKg: input.priceDPerKg,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      setBy: input.setBy,
      note: input.note?.trim() || null,
    })
    .returning();
  if (!row) throw new Error("Could not record the product price.");

  await db.insert(auditLog).values({
    action: "product_price.set",
    entityTable: "product_prices",
    entityId: row.id,
    payload: { product: input.product, priceDPerKg: input.priceDPerKg, note: input.note ?? null },
    actorId: input.setBy,
    actorRole: "owner",
    occurredAt: row.effectiveFrom,
  });

  return { id: row.id, priceDPerKg: row.priceDPerKg, effectiveFrom: row.effectiveFrom };
}
