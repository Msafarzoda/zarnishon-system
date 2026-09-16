"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, sessions, users } from "@/db/schema/index";
import { requireRole, type Role } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { tg } from "@/lib/i18n/tg";

const ROLES: readonly Role[] = [
  "guard", "weigher", "lab", "merchandiser", "cashier", "accountant", "owner", "admin",
];

type State = { error?: string; ok?: string };

/** Passwords are never logged, here or anywhere. Only the fact that one changed is. */
const MIN_PASSWORD = 6;

export async function addUserAction(_prev: State, form: FormData): Promise<State> {
  const actor = await requireRole("admin", "owner");

  const fullName = String(form.get("fullName") ?? "").trim();
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const role = String(form.get("role") ?? "") as Role;
  const password = String(form.get("password") ?? "");

  if (!fullName || !username) return { error: tg.common.required };
  if (!ROLES.includes(role)) return { error: tg.common.required };
  if (password.length < MIN_PASSWORD) return { error: tg.users.passwordTooShort };

  const [clash] = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, username)).limit(1);
  if (clash) return { error: tg.users.usernameTaken };

  const [row] = await db
    .insert(users)
    .values({ username, fullName, role, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });
  if (!row) return { error: tg.common.error };

  await db.insert(auditLog).values({
    action: "user.create",
    entityTable: "users",
    entityId: row.id,
    payload: { username, fullName, role },
    actorId: actor.id,
    actorRole: actor.role,
    occurredAt: new Date(),
  });

  revalidatePath("/idora");
  return { ok: tg.users.created };
}

export async function setPasswordAction(_prev: State, form: FormData): Promise<State> {
  const actor = await requireRole("admin", "owner");

  const userId = String(form.get("userId") ?? "");
  const password = String(form.get("password") ?? "");
  if (!userId) return { error: tg.common.required };
  if (password.length < MIN_PASSWORD) return { error: tg.users.passwordTooShort };

  await db.update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, userId));

  // Every session of theirs ends: a password change that leaves the old one working is
  // not a password change.
  await db.delete(sessions).where(eq(sessions.userId, userId));

  await db.insert(auditLog).values({
    action: "user.password",
    entityTable: "users",
    entityId: userId,
    payload: { by: actor.username },
    actorId: actor.id,
    actorRole: actor.role,
    occurredAt: new Date(),
  });

  revalidatePath("/idora");
  return { ok: tg.users.passwordChanged };
}

export async function setActiveAction(_prev: State, form: FormData): Promise<State> {
  const actor = await requireRole("admin", "owner");

  const userId = String(form.get("userId") ?? "");
  const active = String(form.get("active") ?? "") === "true";
  if (!userId) return { error: tg.common.required };

  // Locking yourself out leaves the factory with nobody who can unlock it.
  if (userId === actor.id && !active) return { error: tg.users.cannotDisableSelf };

  await db.update(users)
    .set({ isActive: active, disabledAt: active ? null : new Date() })
    .where(eq(users.id, userId));

  if (!active) await db.delete(sessions).where(eq(sessions.userId, userId));

  await db.insert(auditLog).values({
    action: active ? "user.enable" : "user.disable",
    entityTable: "users",
    entityId: userId,
    actorId: actor.id,
    actorRole: actor.role,
    occurredAt: new Date(),
  });

  revalidatePath("/idora");
  return { ok: tg.common.saved };
}


/**
 * Дастрасии иловагӣ — granting a user roles on top of their primary one.
 *
 * One operator runs the scale, the lab and the cash desk during the parallel season. This
 * is how that is expressed: roles are *granted*, never by loosening a permission check —
 * so taking them away again, when there is a second person to do the lab, is unticking a
 * box here and nothing else. docs/domain.md §6.
 *
 * The primary role is never included: it is held already, and storing it twice would make
 * "which roles were added" unanswerable.
 */
export async function setExtraRolesAction(_prev: State, form: FormData): Promise<State> {
  const actor = await requireRole("admin", "owner");

  const userId = String(form.get("userId") ?? "");
  if (!userId) return { error: tg.common.required };

  const [target] = await db
    .select({ id: users.id, role: users.role, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { error: tg.common.error };

  const chosen = form.getAll("extraRole").map(String) as Role[];
  if (chosen.some((r) => !ROLES.includes(r))) return { error: tg.common.error };

  const extraRoles = [...new Set(chosen)].filter((r) => r !== target.role);

  await db.update(users).set({ extraRoles }).where(eq(users.id, userId));

  /*
   * Their open sessions carry the roles they signed in with, so they are ended: a
   * revoked role that keeps working until the browser is closed is not revoked, and a
   * granted one that needs a sign-out to appear looks broken.
   */
  await db.delete(sessions).where(eq(sessions.userId, userId));

  await db.insert(auditLog).values({
    action: "user.roles",
    entityTable: "users",
    entityId: userId,
    payload: { user: target.fullName, primary: target.role, extraRoles },
    actorId: actor.id,
    actorRole: actor.role,
    occurredAt: new Date(),
  });

  revalidatePath("/idora");
  return { ok: tg.common.saved };
}
