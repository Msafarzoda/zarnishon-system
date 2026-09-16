import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db/client";
import { syncOperations } from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { AuthError, currentUser, hasRole, type CurrentUser, type Role } from "@/lib/auth/session";

/**
 * Every station write goes through here.
 *
 * Two things matter. First, the caller's role is checked on the server, so hiding a
 * button is never what keeps a cashier off the weighbridge. Second, the operation's
 * client-generated UUID is recorded with its outcome, so an offline queue replaying
 * after a flaky connection gets the original answer back instead of doing the work
 * twice. docs/domain.md §5.
 */
export function handler<S extends z.ZodTypeAny>(opts: {
  operation: string;
  roles: Role[];
  schema: S;
  run: (input: z.infer<S>, user: CurrentUser) => Promise<unknown>;
}) {
  return async function POST(request: Request): Promise<NextResponse> {
    let user: CurrentUser;
    try {
      const found = await currentUser();
      if (!found) throw new AuthError("NOT_SIGNED_IN");
      // The union, not the primary role: one operator holds the scale, the lab and the
      // cash desk during the parallel season, and a check against `role` alone rejects
      // two thirds of their own work with a 401. docs/domain.md §6.
      if (!hasRole(found, opts.roles)) throw new AuthError("FORBIDDEN");
      user = found;
    } catch {
      return NextResponse.json({ error: "NOT_AUTHORISED" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
    }

    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "INVALID_INPUT", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const input = parsed.data as z.infer<S> & { clientUuid?: string };
    const clientUuid = input.clientUuid;

    // Replay of an operation the server has already decided on.
    if (clientUuid) {
      const [seen] = await db
        .select()
        .from(syncOperations)
        .where(eq(syncOperations.clientUuid, clientUuid))
        .limit(1);
      if (seen) {
        return seen.status === "APPLIED"
          ? NextResponse.json({ ...(seen.resultJson as object), replayed: true })
          : NextResponse.json({ error: seen.errorMessage ?? "REJECTED" }, { status: 422 });
      }
    }

    try {
      const result = await opts.run(input, user);
      if (clientUuid) {
        await db
          .insert(syncOperations)
          .values({
            clientUuid,
            operation: opts.operation,
            requestHash: hash(body),
            status: "APPLIED",
            resultJson: result as object,
            stationId: user.stationId,
            actorId: user.id,
          })
          .onConflictDoNothing();
      }
      return NextResponse.json(result);
    } catch (err) {
      // A DomainError is the business refusing the operation on its merits — already
      // paid, tare above gross, no approved analysis. That is final: the station must
      // show it to the operator, not retry it for ever.
      const isDomain = err instanceof DomainError;
      const message = err instanceof Error ? err.message : "UNKNOWN_ERROR";

      if (clientUuid && isDomain) {
        await db
          .insert(syncOperations)
          .values({
            clientUuid,
            operation: opts.operation,
            requestHash: hash(body),
            status: "REJECTED",
            errorMessage: message,
            stationId: user.stationId,
            actorId: user.id,
          })
          .onConflictDoNothing();
      }

      if (isDomain) return NextResponse.json({ error: message }, { status: 422 });
      console.error(`[${opts.operation}]`, err);
      return NextResponse.json({ error: "SERVER_ERROR" }, { status: 500 });
    }
  };
}

function hash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}
