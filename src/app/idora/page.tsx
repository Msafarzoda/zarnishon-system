import { asc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema/index";
import { requirePageRole, STATION_ROLES, type Role } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { UsersClient, type UserRow } from "./users-client";

export const dynamic = "force-dynamic";

/**
 * The password every account is seeded with. A user who still has it has, in effect, no
 * password at all — the seed file is in the repository. The page says so per-row until
 * it is changed, which is the only way that fact ever reaches the owner.
 */
const SEED_PASSWORD = "zarnishon";

/**
 * Идора — user management.
 *
 * The only screen that decides who may touch money or weight, so it exists to answer
 * three questions at a glance: who has an account, what can each of them reach, and
 * which of them are still on the password that shipped with the system.
 *
 * Sessions are counted in a subquery with the table named explicitly — interpolating a
 * Drizzle column into a raw template renders it unqualified and collides with the join.
 */
export default async function AdminPage() {
  const me = await requirePageRole("admin", "owner");

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      extraRoles: users.extraRoles,
      isActive: users.isActive,
      createdAt: users.createdAt,
      passwordHash: users.passwordHash,
      openSessions: raw<string>`COALESCE((
        SELECT COUNT(*) FROM sessions s
        WHERE s.user_id = users.id AND s.expires_at > now()
      ), 0)`,
      lastSeen: raw<string | null>`(
        SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = users.id
      )`,
    })
    .from(users)
    .orderBy(asc(users.isActive), asc(users.fullName));

  const list: UserRow[] = await Promise.all(
    rows.map(async (u) => ({
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      role: u.role,
      extraRoles: (u.extraRoles ?? []) as Role[],
      isActive: u.isActive,
      isSelf: u.id === me.id,
      // Checked here rather than stored: nothing must ever persist a claim about a password.
      usesSeedPassword: await verifyPassword(SEED_PASSWORD, u.passwordHash),
      openSessions: Number(u.openSessions),
      lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
      createdAt: u.createdAt.toISOString(),
    })),
  );

  return (
    <Shell user={me} title={tg.users.title}>
      <UsersClient users={list} stationRoles={[...STATION_ROLES] as Role[]} />
    </Shell>
  );
}
