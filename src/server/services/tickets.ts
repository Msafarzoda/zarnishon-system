import { and, desc, eq, gt, sql as raw } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  labAnalyses,
  serialBlocks,
  stations,
  weighEvents,
  weighTickets,
} from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { netWeight } from "@/domain/weight";
import { transition } from "@/domain/ticket";
import type { TicketStatus } from "@/domain/ticket";

/**
 * Take the next serial from this station's pre-allocated block.
 *
 * Blocks are contiguous, so a serial that is drawn and never turns into a ticket shows
 * up as a gap — that is the point: missing paper is detectable. docs/domain.md §2.
 */
async function allocateSerial(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  stationId: string,
  season: number,
): Promise<{ serial: string; serialNumber: number }> {
  const [station] = await tx
    .select({ code: stations.code })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  if (!station) throw new DomainError("Ҷойгоҳ ёфт нашуд. / Station not found.");

  const [block] = await tx
    .select()
    .from(serialBlocks)
    .where(
      and(
        eq(serialBlocks.stationId, stationId),
        eq(serialBlocks.season, season),
        gt(raw`${serialBlocks.rangeEnd} + 1`, serialBlocks.nextSerial),
      ),
    )
    .orderBy(serialBlocks.rangeStart)
    .for("update")
    .limit(1);

  if (!block) {
    throw new DomainError(
      `Рақамҳои борхат тамом шуданд. / This station has no unused ticket numbers left for ` +
        `season ${season} — the owner must issue a new serial block.`,
    );
  }

  const serialNumber = block.nextSerial;
  await tx
    .update(serialBlocks)
    .set({ nextSerial: serialNumber + 1 })
    .where(eq(serialBlocks.id, block.id));

  return {
    serial: `${station.code}-${season}-${String(serialNumber).padStart(6, "0")}`,
    serialNumber,
  };
}

export interface CreateTicketInput {
  clientUuid: string;
  season: number;
  stationId: string;
  createdBy: string;
  consignorId: string;
  payerId?: string;
  driverId?: string;
  vehicleId?: string;
  batchId?: string;
  varietyId?: string;
  grade?: number;
  cottonClass?: string;
  loadingPlace?: string;
  unloadingPlace?: string;
  routeNo?: string;
  originatedOffline?: boolean;
}

/** Opens a Борхат for a truck that has arrived. No weight yet. */
export async function createTicket(input: CreateTicketInput) {
  const [replay] = await db
    .select()
    .from(weighTickets)
    .where(eq(weighTickets.clientUuid, input.clientUuid))
    .limit(1);
  if (replay) return replay;

  return await db.transaction(async (tx) => {
    const { serial, serialNumber } = await allocateSerial(tx, input.stationId, input.season);

    const [ticket] = await tx
      .insert(weighTickets)
      .values({
        clientUuid: input.clientUuid,
        serial,
        season: input.season,
        serialNumber,
        status: "DRAFT",
        gate: "ARRIVED",
        consignorId: input.consignorId,
        payerId: input.payerId ?? input.consignorId,
        driverId: input.driverId ?? null,
        vehicleId: input.vehicleId ?? null,
        batchId: input.batchId ?? null,
        varietyId: input.varietyId ?? null,
        grade: input.grade ?? null,
        cottonClass: input.cottonClass ?? null,
        loadingPlace: input.loadingPlace ?? null,
        unloadingPlace: input.unloadingPlace ?? null,
        routeNo: input.routeNo ?? null,
        stationId: input.stationId,
        createdBy: input.createdBy,
        originatedOffline: input.originatedOffline ? 1 : 0,
      })
      .returning();
    if (!ticket) throw new Error("Could not open the ticket.");

    await tx.insert(auditLog).values({
      action: "ticket.create",
      entityTable: "weigh_tickets",
      entityId: ticket.id,
      payload: { serial, consignorId: input.consignorId },
      actorId: input.createdBy,
      stationId: input.stationId,
      originatedOffline: input.originatedOffline ? 1 : 0,
      occurredAt: new Date(),
    });

    return ticket;
  });
}

export interface CaptureWeightInput {
  clientUuid: string;
  ticketId: string;
  kind: "GROSS" | "TARE";
  weightG: number;
  operatorId: string;
  stationId: string;
  capturedAt?: Date;
  source?: "manual" | "indicator";
  photoRef?: string;
  indicatorRaw?: string;
  deviceFingerprint?: string;
  originatedOffline?: boolean;
  /** Set to correct an earlier weighing. Both events stay in the record. */
  supersedesId?: string;
  reason?: string;
}

/**
 * Record a weighing. The event is appended and never modified; the ticket's
 * gross/tare/net columns are only a snapshot of the newest non-superseded events.
 */
export async function captureWeight(input: CaptureWeightInput) {
  const [replay] = await db
    .select()
    .from(weighEvents)
    .where(eq(weighEvents.clientUuid, input.clientUuid))
    .limit(1);
  if (replay) return { eventId: replay.id, replayed: true as const };

  if (input.supersedesId && !input.reason?.trim()) {
    throw new DomainError(
      "Барои ислоҳи вазн сабаб ҳатмист. / Correcting a weight requires a reason.",
    );
  }

  return await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select()
      .from(weighTickets)
      .where(eq(weighTickets.id, input.ticketId))
      .for("update")
      .limit(1);
    if (!ticket) throw new DomainError("Борхат ёфт нашуд. / Ticket not found.");
    if (ticket.status === "PAID" || ticket.status === "VOID") {
      throw new DomainError(
        "Борхати пардохтшуда ё бекоршуда баркашида намешавад. / " +
          "A paid or voided ticket cannot be re-weighed.",
      );
    }

    const capturedAt = input.capturedAt ?? new Date();
    const [event] = await tx
      .insert(weighEvents)
      .values({
        clientUuid: input.clientUuid,
        ticketId: ticket.id,
        kind: input.kind,
        weightG: input.weightG,
        source: input.source ?? "manual",
        photoRef: input.photoRef ?? null,
        indicatorRaw: input.indicatorRaw ?? null,
        capturedAt,
        operatorId: input.operatorId,
        stationId: input.stationId,
        deviceFingerprint: input.deviceFingerprint ?? null,
        originatedOffline: input.originatedOffline ? 1 : 0,
        supersedesId: input.supersedesId ?? null,
        reason: input.reason?.trim() ?? null,
      })
      .returning();
    if (!event) throw new Error("Could not record the weighing.");

    // Re-derive the snapshot from the events that have not been superseded.
    const grossG = await latestWeight(tx, ticket.id, "GROSS");
    const tareG = await latestWeight(tx, ticket.id, "TARE");
    const netG = grossG !== null && tareG !== null ? netWeight(grossG, tareG) : null;

    let status = ticket.status as TicketStatus;
    if (input.kind === "GROSS" && status === "DRAFT") status = transition(status, "CAPTURE_GROSS");
    if (netG !== null && status === "OPEN") status = transition(status, "CAPTURE_TARE");

    // A партия is usually analysed after the trucks stop coming, and approving it
    // promotes everything already weighed. But a truck that arrives AFTER approval
    // would otherwise sit at WEIGHED for ever: no second approval is coming, so it
    // would never become payable and would simply disappear from the cash desk.
    // Its партия is already analysed, so it is payable the moment нетто is known.
    let analysedAt: Date | null = ticket.analysedAt;
    if (status === "WEIGHED" && ticket.batchId) {
      const [approved] = await tx
        .select({ id: labAnalyses.id })
        .from(labAnalyses)
        .where(
          and(
            eq(labAnalyses.batchId, ticket.batchId),
            eq(labAnalyses.stage, "on_intake"),
            eq(labAnalyses.status, "APPROVED"),
          ),
        )
        .limit(1);
      if (approved) {
        status = transition(status, "APPROVE_ANALYSIS");
        analysedAt = capturedAt;
      }
    }

    await tx
      .update(weighTickets)
      .set({
        grossG,
        tareG,
        netG,
        status,
        gate:
          input.kind === "GROSS"
            ? "WEIGHED_GROSS"
            : netG !== null
              ? "WEIGHED_TARE"
              : ticket.gate,
        weighedAt: netG !== null ? capturedAt : ticket.weighedAt,
        analysedAt,
      })
      .where(eq(weighTickets.id, ticket.id));

    await tx.insert(auditLog).values({
      action: input.supersedesId ? "ticket.weight.correct" : "ticket.weight.capture",
      entityTable: "weigh_events",
      entityId: event.id,
      payload: {
        serial: ticket.serial,
        kind: input.kind,
        weightG: input.weightG,
        source: input.source ?? "manual",
        supersedesId: input.supersedesId ?? null,
        reason: input.reason ?? null,
      },
      actorId: input.operatorId,
      actorRole: "weigher",
      stationId: input.stationId,
      deviceFingerprint: input.deviceFingerprint ?? null,
      originatedOffline: input.originatedOffline ? 1 : 0,
      occurredAt: capturedAt,
    });

    return { eventId: event.id, grossG, tareG, netG, status, replayed: false as const };
  });
}

/** Newest weighing of one kind that nothing later supersedes. */
async function latestWeight(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ticketId: string,
  kind: "GROSS" | "TARE",
): Promise<number | null> {
  const rows = await tx
    .select()
    .from(weighEvents)
    .where(and(eq(weighEvents.ticketId, ticketId), eq(weighEvents.kind, kind)))
    .orderBy(desc(weighEvents.recordedAt));

  const superseded = new Set(rows.map((r) => r.supersedesId).filter(Boolean) as string[]);
  const live = rows.find((r) => !superseded.has(r.id));
  return live ? live.weightG : null;
}

export async function voidTicket(args: {
  ticketId: string;
  actorId: string;
  reason: string;
}) {
  if (!args.reason.trim()) {
    throw new DomainError("Сабаби бекоркунӣ ҳатмист. / Voiding requires a reason.");
  }
  return await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select()
      .from(weighTickets)
      .where(eq(weighTickets.id, args.ticketId))
      .for("update")
      .limit(1);
    if (!ticket) throw new DomainError("Борхат ёфт нашуд. / Ticket not found.");

    const next = transition(ticket.status as TicketStatus, "VOID");
    const now = new Date();
    await tx
      .update(weighTickets)
      .set({ status: next, voidedAt: now, voidedBy: args.actorId, voidReason: args.reason.trim() })
      .where(eq(weighTickets.id, ticket.id));

    await tx.insert(auditLog).values({
      action: "ticket.void",
      entityTable: "weigh_tickets",
      entityId: ticket.id,
      payload: { serial: ticket.serial, previousStatus: ticket.status, reason: args.reason },
      actorId: args.actorId,
      occurredAt: now,
    });
    return { ticketId: ticket.id, status: next };
  });
}

/**
 * Қайди дарвоза — the guard marking a truck out through the gate.
 *
 * The guard touches nothing but the gate state: no weights, no batch, no money.
 * A truck cannot be signed out before its empty weight has been taken, which is what
 * stops a loaded truck leaving against a ticket that was never completed.
 */
export async function markDeparted(args: {
  ticketId: string;
  actorId: string;
  at?: Date;
}) {
  return await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select()
      .from(weighTickets)
      .where(eq(weighTickets.id, args.ticketId))
      .for("update")
      .limit(1);
    if (!ticket) throw new DomainError("Борхат ёфт нашуд. / Ticket not found.");

    if (ticket.gate === "DEPARTED") {
      return { ticketId: ticket.id, gate: ticket.gate, alreadyDeparted: true };
    }
    if (ticket.tareG === null) {
      throw new DomainError(
        "Мошин ҳанӯз тара дода нашудааст. / This truck has not been weighed empty yet — " +
          "it may not leave.",
      );
    }

    const at = args.at ?? new Date();
    await tx
      .update(weighTickets)
      .set({ gate: "DEPARTED", departedAt: at })
      .where(eq(weighTickets.id, ticket.id));

    await tx.insert(auditLog).values({
      action: "gate.depart",
      entityTable: "weigh_tickets",
      entityId: ticket.id,
      payload: { serial: ticket.serial, tareG: ticket.tareG },
      actorId: args.actorId,
      actorRole: "guard",
      occurredAt: at,
    });

    return { ticketId: ticket.id, gate: "DEPARTED" as const, alreadyDeparted: false };
  });
}
