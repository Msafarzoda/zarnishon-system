"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { auditLog, counterparties, drivers, vehicles } from "@/db/schema/index";
import { requireRole } from "@/lib/auth/session";
import { DomainError } from "@/domain/units";
import { isTransportOrg, normalisePlate } from "@/domain/plate";
import { tg } from "@/lib/i18n/tg";

export async function addFarmAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "cashier", "owner", "accountant", "admin");

  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: tg.common.required };

  const [row] = await db
    .insert(counterparties)
    .values({
      kind: (String(form.get("kind") ?? "farm") as "farm" | "individual" | "company"),
      name,
      tin: String(form.get("tin") ?? "").trim() || null,
      defaultLocation: String(form.get("place") ?? "").trim() || null,
      brigadeCode: String(form.get("brigade") ?? "").trim() || null,
      phone: String(form.get("phone") ?? "").trim() || null,
      createdBy: user.id,
    })
    .returning();
  if (!row) return { error: tg.common.error };

  await db.insert(auditLog).values({
    action: "counterparty.create",
    entityTable: "counterparties",
    entityId: row.id,
    payload: { name, tin: row.tin },
    actorId: user.id,
    occurredAt: new Date(),
  });

  revalidatePath("/khojagiho");
  revalidatePath("/tarozu");
  return { ok: tg.common.saved };
}

export async function addVehicleAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "weigher", "owner", "admin");

  let plate: string;
  try {
    // Same folding as the weighbridge, so a truck added here and a truck added at the
    // scale cannot end up as two records. See src/domain/plate.ts.
    plate = normalisePlate(String(form.get("plate") ?? "")).plate;
  } catch (err) {
    return { error: err instanceof DomainError ? err.message : tg.common.required };
  }

  const org = String(form.get("transportOrg") ?? "").trim();

  await db
    .insert(vehicles)
    .values({
      plate,
      model: String(form.get("model") ?? "").trim() || null,
      transportOrg: isTransportOrg(org) ? org : null,
      createdBy: user.id,
    })
    .onConflictDoNothing();

  revalidatePath("/khojagiho");
  revalidatePath("/tarozu");
  return { ok: tg.common.saved };
}

export async function addDriverAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "weigher", "owner", "admin");
  const fullName = String(form.get("fullName") ?? "").trim();
  if (!fullName) return { error: tg.common.required };

  await db.insert(drivers).values({
    fullName,
    phone: String(form.get("phone") ?? "").trim() || null,
    createdBy: user.id,
  });

  revalidatePath("/khojagiho");
  revalidatePath("/tarozu");
  return { ok: tg.common.saved };
}
