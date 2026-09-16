import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { sessions, stations, users } from "@/db/schema/index";
import { newSessionToken, verifyPassword } from "./password";

const COOKIE = "zarnishon_session";
const TTL_MS = 12 * 60 * 60 * 1000; // one long factory shift

export type Role =
  | "guard"
  | "weigher"
  | "lab"
  | "merchandiser"
  | "cashier"
  | "accountant"
  | "owner"
  | "admin";

export interface CurrentUser {
  id: string;
  username: string;
  fullName: string;
  /** The job this person is called by, and where they land after signing in. */
  role: Role;
  /**
   * Every role this person holds — the primary one plus any extras.
   *
   * One operator runs the scale, the lab and the cash desk during the parallel season, so
   * a permission check that only looked at `role` would lock them out of two thirds of
   * their own job. Every check in this module tests this list. docs/domain.md §6.
   */
  roles: Role[];
  stationId: string | null;
  stationCode: string | null;
  stationName: string | null;
}

/** Whether this user holds any of `allowed`, counting extra roles. */
export function hasRole(user: CurrentUser, allowed: readonly Role[]): boolean {
  return user.roles.some((r) => allowed.includes(r));
}

export async function signIn(
  username: string,
  password: string,
  stationId?: string,
): Promise<CurrentUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.trim().toLowerCase()), eq(users.isActive, true)))
    .limit(1);
  if (!user) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;

  // Refuse the sign-in rather than let the shift start in a state that cannot work. One
  // operator holding several roles needs a station if any of them works at one.
  const held = [user.role as Role, ...((user.extraRoles ?? []) as Role[])];
  if (held.some(needsStation) && !stationId) {
    throw new AuthError("STATION_REQUIRED");
  }

  const token = newSessionToken();
  await db.insert(sessions).values({
    id: token,
    userId: user.id,
    stationId: stationId ?? null,
    expiresAt: new Date(Date.now() + TTL_MS),
  });

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_MS / 1000,
  });

  return await currentUser();
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, token));
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      extraRoles: users.extraRoles,
      isActive: users.isActive,
      stationId: sessions.stationId,
      stationCode: stations.code,
      stationName: stations.nameTg,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(stations, eq(stations.id, sessions.stationId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row || !row.isActive) return null;
  const primary = row.role as Role;
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    role: primary,
    // The primary role first, then extras, with no duplicates.
    roles: [primary, ...((row.extraRoles ?? []) as Role[]).filter((r) => r !== primary)],
    stationId: row.stationId,
    stationCode: row.stationCode,
    stationName: row.stationName,
  };
}

/**
 * Separation of duties is enforced here, on the server, for every screen and every
 * action — not by hiding buttons. A cashier who types a weighbridge URL is refused.
 * docs/domain.md §6.
 */
export async function requireRole(...allowed: Role[]): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) throw new AuthError("NOT_SIGNED_IN");
  // The owner may look at anything, but is not granted operational roles by this check;
  // screens that move money list `owner` explicitly when he is allowed to act.
  if (!hasRole(user, allowed)) {
    throw new AuthError("FORBIDDEN");
  }
  return user;
}

/**
 * Roles that work at a physical place, and whose every record is stamped with it.
 *
 * Signing in without choosing one leaves a weigher who cannot weigh: the station is
 * required on a Борхат, so the first truck of the shift fails — and until this was
 * enforced it failed as an HTTP 500 that the station reported as "offline".
 */
export const STATION_ROLES: readonly Role[] = ["weigher", "lab", "cashier", "guard"];

export function needsStation(role: Role): boolean {
  return STATION_ROLES.includes(role);
}

export class AuthError extends Error {
  constructor(public code: "NOT_SIGNED_IN" | "FORBIDDEN" | "STATION_REQUIRED") {
    super(code);
    this.name = "AuthError";
  }
}

/**
 * Where this person lands after signing in.
 *
 * Somebody holding more than one operational job goes to the work board, which shows the
 * whole line, rather than to whichever single station happens to be their primary role —
 * they would only have to navigate away from it. docs/domain.md §6.
 */
export function homeFor(user: Pick<CurrentUser, "role" | "roles">): string {
  const operational = user.roles.filter((r) =>
    (["weigher", "lab", "cashier", "merchandiser"] as Role[]).includes(r),
  );
  if (operational.length > 1) return "/kor";
  return homePathFor(user.role);
}

/** Which screen a single role lands on after signing in. */
export function homePathFor(role: Role): string {
  switch (role) {
    case "guard":
      return "/darvoza";
    case "weigher":
      return "/tarozu";
    case "lab":
      return "/laboratoriya";
    case "cashier":
      return "/hazina";
    case "owner":
    case "accountant":
      return "/hisobot";
    case "merchandiser":
      return "/partiyaho";
    default:
      return "/idora";
  }
}

/**
 * Role check for a **page**.
 *
 * `requireRole` throws, which is right for an API route but renders a crash page when a
 * server component does it — a лаборант who types /hazina, or follows a stale link, got
 * an HTTP 500. Here, not signed in sends you to the login screen and the wrong role
 * sends you to a page that says so in Tajik.
 */
export async function requirePageRole(...allowed: Role[]): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) redirect("/vorud");
  if (!hasRole(user, allowed)) {
    redirect("/dastrasi");
  }
  return user;
}

/**
 * Whether this user may *act* on a screen, as opposed to merely read it.
 *
 * The owner sees everything and the accountant reads everything — but neither weighs a
 * truck, signs off an analysis or hands over cash. Letting them open the operational
 * screens read-only keeps oversight possible without putting either of them inside the
 * money path. The API enforces the same split independently, so a control that leaked
 * onto the page would still be refused.
 */
export function canOperate(user: CurrentUser, operators: readonly Role[]): boolean {
  return hasRole(user, operators);
}
