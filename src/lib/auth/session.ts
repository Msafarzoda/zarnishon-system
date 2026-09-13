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
  role: Role;
  stationId: string | null;
  stationCode: string | null;
  stationName: string | null;
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
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    role: row.role as Role,
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
  if (!allowed.includes(user.role) && !(user.role === "admin" && allowed.includes("admin"))) {
    throw new AuthError("FORBIDDEN");
  }
  return user;
}

export class AuthError extends Error {
  constructor(public code: "NOT_SIGNED_IN" | "FORBIDDEN") {
    super(code);
    this.name = "AuthError";
  }
}

/** Which screen a role lands on after signing in. */
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
  if (!allowed.includes(user.role) && !(user.role === "admin" && allowed.includes("admin"))) {
    redirect("/dastrasi");
  }
  return user;
}
