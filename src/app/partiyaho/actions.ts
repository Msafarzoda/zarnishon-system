"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, batches, weighTickets } from "@/db/schema/index";
import { requireRole } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";

export async function openBatchAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "owner", "admin");

  const number = Number(form.get("number"));
  const season = Number(form.get("season"));
  if (!Number.isInteger(number) || number <= 0) return { error: tg.common.required };

  const [clash] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.season, season), eq(batches.number, number)))
    .limit(1);
  if (clash) {
    return { error: `${tg.ticket.batch} ${number} — ${tg.common.error}` };
  }

  const grade = Number(form.get("grade"));
  const [row] = await db
    .insert(batches)
    .values({
      number,
      season,
      varietyId: String(form.get("varietyId") ?? "") || null,
      grade: Number.isInteger(grade) && grade > 0 ? grade : null,
      cottonClass: String(form.get("cottonClass") ?? "").trim() || null,
      storageLocationId: String(form.get("storageLocationId") ?? "") || null,
    })
    .returning();
  if (!row) return { error: tg.common.error };

  await db.insert(auditLog).values({
    action: "batch.open",
    entityTable: "batches",
    entityId: row.id,
    payload: { number, season },
    actorId: user.id,
    occurredAt: new Date(),
  });

  revalidatePath("/partiyaho");
  revalidatePath("/tarozu");
  return { ok: tg.common.saved };
}

/**
 * Closing a партия stops any further truck being added to it. It is refused while a
 * truck is still on the weighbridge against it, so cotton cannot land in a lot that the
 * lab has already signed off.
 */
export async function closeBatchAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "owner");
  const batchId = String(form.get("batchId") ?? "");
  if (!batchId) return { error: tg.common.required };

  const [open] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(weighTickets)
    .where(and(eq(weighTickets.batchId, batchId), eq(weighTickets.status, "OPEN")));

  if (Number(open?.n ?? 0) > 0) {
    return { error: `${tg.gate.awaitingTare}: ${open?.n} — ${tg.common.error}` };
  }

  await db
    .update(batches)
    .set({ closedAt: new Date(), closedBy: user.id })
    .where(eq(batches.id, batchId));

  await db.insert(auditLog).values({
    action: "batch.close",
    entityTable: "batches",
    entityId: batchId,
    actorId: user.id,
    occurredAt: new Date(),
  });

  revalidatePath("/partiyaho");
  return { ok: tg.common.saved };
}
