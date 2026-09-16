"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, counterparties, drivers, vehicles } from "@/db/schema/index";
import { requireRole } from "@/lib/auth/session";
import { DomainError } from "@/domain/units";
import { isPlausibleTin, isTransportOrg, normalisePlate, normaliseTin } from "@/domain/plate";
import { tg } from "@/lib/i18n/tg";

export async function addFarmAction(_prev: { error?: string; ok?: string }, form: FormData) {
  const user = await requireRole("merchandiser", "cashier", "owner", "accountant", "admin");

  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: tg.common.required };

  const kind = String(form.get("kind") ?? "farm") as "farm" | "individual" | "company";

  /*
   * The РМА is the farm's identity, so it is required and unique rather than a note on
   * the record. Two spellings of one name create two farms whose cotton, advances and
   * balance are split between them and nobody notices; one number cannot. Normalised
   * first, because the same number is written with spaces or dashes depending on who
   * filled in the waybill. docs/domain.md §6.
   */
  const tinRaw = String(form.get("tin") ?? "").trim();
  let tin: string | null = null;
  if (kind === "farm") {
    if (!tinRaw) return { error: tg.common.tinRequired };
    if (!isPlausibleTin(tinRaw)) return { error: tg.common.tinInvalid };
    tin = normaliseTin(tinRaw);

    const [clash] = await db
      .select({ name: counterparties.name })
      .from(counterparties)
      .where(eq(counterparties.tin, tin))
      .limit(1);
    if (clash) return { error: `${tg.common.tinTakenBy}: ${clash.name}` };
  } else if (tinRaw) {
    tin = normaliseTin(tinRaw);
  }

  const [row] = await db
    .insert(counterparties)
    .values({
      kind,
      name,
      tin,
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
