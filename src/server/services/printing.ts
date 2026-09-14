import { and, eq, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, payments, weighTickets } from "@/db/schema/index";
import { DomainError } from "@/domain/units";

/**
 * Recording every print of a Борхат.
 *
 * The stamped driver's copy is a bearer instrument: whoever holds it can claim payment.
 * Nothing in software can stop a person pressing Ctrl+P, so the control is not
 * prevention — it is that **every print is recorded and every reprint is visible to the
 * owner**, with who printed it and when.
 *
 * A first print is routine. A second print of the same ticket means a second stamped
 * driver's copy may exist, and that is exactly what the owner needs to see.
 */

export type PrintKind = "borkhat" | "tahlil" | "pardokht";

export interface RecordPrintInput {
  clientUuid: string;
  /** The Борхат, for the waybill and the lab certificate. */
  ticketId?: string;
  /** The payment, for the cash receipt. Exactly one of the two. */
  paymentId?: string;
  /** Which document: the Борхат itself, or the lab's Форма №9-хл certificate. */
  kind?: PrintKind;
  actorId: string;
  actorRole: string;
  stationId?: string;
  reason?: string;
}

export async function recordPrint(input: RecordPrintInput) {
  const kind: PrintKind = input.kind ?? "borkhat";
  const action =
    kind === "tahlil" ? "lab.print" : kind === "pardokht" ? "payment.print" : "ticket.print";

  // The receipt is keyed on the payment; the waybill and certificate on the Борхат.
  let entityId: string;
  let entityTable: string;
  let serial: string;

  if (kind === "pardokht") {
    if (!input.paymentId) throw new DomainError("paymentId is required for a receipt print.");
    const [payment] = await db
      .select({ id: payments.id, invoiceNo: payments.invoiceNo })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!payment) throw new DomainError("Ҳисобнома ёфт нашуд. / Payment not found.");
    entityId = payment.id;
    entityTable = "payments";
    serial = payment.invoiceNo;
  } else {
    if (!input.ticketId) throw new DomainError("ticketId is required for this print.");
    const [ticket] = await db
      .select({ id: weighTickets.id, serial: weighTickets.serial })
      .from(weighTickets)
      .where(eq(weighTickets.id, input.ticketId))
      .limit(1);
    if (!ticket) throw new DomainError("Борхат ёфт нашуд. / Ticket not found.");
    entityId = ticket.id;
    entityTable = "weigh_tickets";
    serial = ticket.serial;
  }

  const [before] = await db
    .select({ n: raw<string>`COUNT(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));

  const previous = Number(before?.n ?? 0);

  await db.insert(auditLog).values({
    action,
    entityTable,
    entityId,
    payload: {
      serial,
      kind,
      copies: 3,
      // 0 on the original print; 1 and up mean extra stamped copies may now exist.
      reprintNumber: previous,
      reason: input.reason?.trim() ?? null,
    },
    actorId: input.actorId,
    actorRole: input.actorRole,
    stationId: input.stationId ?? null,
    occurredAt: new Date(),
  });

  return { serial, printCount: previous + 1, isReprint: previous > 0 };
}

export interface Reprint {
  serial: string;
  count: number;
  lastAt: Date;
  by: string | null;
}

/** Tickets printed more than once — each extra print is a possible extra driver's copy. */
export async function listReprints(limit = 10): Promise<Reprint[]> {
  const rows = await db.execute<{
    serial: string;
    count: string;
    last_at: Date;
    by: string | null;
  }>(raw`
    SELECT
      (a.payload ->> 'serial')      AS serial,
      COUNT(*)                      AS count,
      MAX(a.occurred_at)            AS last_at,
      MAX(u.full_name)              AS by
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.action = 'ticket.print'
    GROUP BY a.payload ->> 'serial'
    HAVING COUNT(*) > 1
    ORDER BY MAX(a.occurred_at) DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    serial: r.serial,
    count: Number(r.count),
    lastAt: new Date(r.last_at),
    by: r.by,
  }));
}
