"use server";

import { revalidatePath } from "next/cache";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, priceQuotes } from "@/db/schema/index";
import { requireRole } from "@/lib/auth/session";
import { somoniStringToDiram, DomainError } from "@/domain/units";
import { tg } from "@/lib/i18n/tg";

/**
 * Нарх — only the owner sets it. Quotes are effective-dated and never edited: a new
 * price is a new row, so what a past payment used stays visible for ever.
 * docs/domain.md §4.
 */
export async function setPriceAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("owner");

  const raw = String(form.get("price") ?? "");
  const varietyId = String(form.get("varietyId") ?? "") || null;
  const effectiveFrom = String(form.get("effectiveFrom") ?? "");
  const note = String(form.get("note") ?? "").trim() || null;

  let priceDPerKg: number;
  try {
    priceDPerKg = somoniStringToDiram(raw);
  } catch (err) {
    return { error: err instanceof DomainError ? err.message : tg.common.error };
  }
  if (priceDPerKg <= 0) return { error: tg.common.required };

  const from = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(from.getTime())) return { error: tg.common.error };

  const [row] = await db
    .insert(priceQuotes)
    .values({ varietyId, priceDPerKg, effectiveFrom: from, setBy: user.id, note })
    .returning();
  if (!row) return { error: tg.common.error };

  await db.insert(auditLog).values({
    action: "price.set",
    entityTable: "price_quotes",
    entityId: row.id,
    payload: { priceDPerKg, varietyId, effectiveFrom: from.toISOString(), note },
    actorId: user.id,
    actorRole: "owner",
    occurredAt: new Date(),
  });

  revalidatePath("/narkhho");
  revalidatePath("/hisobot");
  revalidatePath("/hazina");
  return { ok: tg.common.saved };
}

export async function listPrices() {
  return await db.select().from(priceQuotes).orderBy(desc(priceQuotes.effectiveFrom)).limit(50);
}
