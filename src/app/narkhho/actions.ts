"use server";

import { revalidatePath } from "next/cache";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, factorySettings, priceQuotes } from "@/db/schema/index";
import { requireRole } from "@/lib/auth/session";
import { somoniStringToDiram, DomainError } from "@/domain/units";
import { getActiveSettings } from "@/server/services/settings";
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


/**
 * Ҳадди қарз — the rate at which cotton in the warehouse secures a loan.
 *
 * A factory setting, not a price: it says how much may be lent per kilogram of a farm's
 * unsettled cotton, and only the owner may move it. Like the deduction norms, settings are
 * never edited — a change is a new row, so a loan issued last month can still be read
 * against the rule that was in force when it was made. docs/domain.md §4.
 *
 * Everything else on the row is carried forward: this form changes one number, and
 * silently resetting the lab's norms to a default while doing so would be a disaster
 * nobody would notice until the next truck was sampled.
 */
export async function setLendingRateAction(
  _prev: { error?: string; ok?: string },
  form: FormData,
) {
  const user = await requireRole("owner");

  const raw = String(form.get("rate") ?? "");
  const reason = String(form.get("reason") ?? "").trim() || null;

  let advanceRateDPerKg: number;
  try {
    advanceRateDPerKg = somoniStringToDiram(raw);
  } catch (err) {
    return { error: err instanceof DomainError ? err.message : tg.common.error };
  }
  if (advanceRateDPerKg <= 0) return { error: tg.lending.mustBePositive };

  const current = await getActiveSettings();
  if (advanceRateDPerKg === current.advanceRateDPerKg) {
    return { error: tg.lending.unchanged };
  }

  const [row] = await db
    .insert(factorySettings)
    .values({
      deductionMode: current.deductionMode,
      normMoistureBp: current.norms.moistureBp,
      normTrashBp: current.norms.trashBp,
      massBalanceToleranceBp: current.massBalanceToleranceBp,
      advanceRateDPerKg,
      setBy: user.id,
      reason,
    })
    .returning();
  if (!row) return { error: tg.common.error };

  await db.insert(auditLog).values({
    action: "settings.lendingRate",
    entityTable: "factory_settings",
    entityId: row.id,
    payload: {
      from: current.advanceRateDPerKg,
      to: advanceRateDPerKg,
      reason,
    },
    actorId: user.id,
    actorRole: "owner",
    occurredAt: new Date(),
  });

  revalidatePath("/narkhho");
  revalidatePath("/hazina");
  revalidatePath("/hisobot");
  return { ok: tg.common.saved };
}
