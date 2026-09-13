import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, labAnalyses, weighTickets } from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { deductionBp as computeDeduction } from "@/domain/weight";
import { transition } from "@/domain/ticket";
import type { TicketStatus } from "@/domain/ticket";
import { getActiveSettings } from "./settings";

export interface CreateAnalysisInput {
  clientUuid: string;
  /** The truck this sample came from. The normal case. */
  ticketId?: string;
  /** A whole партия certified at once instead. Exactly one of the two. */
  batchId?: string;
  stage?: "on_intake" | "on_dispatch";
  moistureBp: number;
  trashBp: number;
  storageNote?: string;
  sampledAt?: Date;
  labUserId: string;
}

/**
 * Enter a Форма №9-хл reading. Stays DRAFT until the lab approves it.
 *
 * Every truck is sampled, so this normally names a ticket. Naming a партия instead
 * certifies the whole lot at once, which is what the paper form is written for.
 */
export async function createAnalysis(input: CreateAnalysisInput) {
  if (!input.ticketId === !input.batchId) {
    throw new DomainError(
      "Таҳлил бояд ба як борхат ё ба як партия тааллуқ дошта бошад. / " +
        "An analysis must name exactly one of a ticket or a batch.",
    );
  }

  // Replay of a queued creation.
  const [replay] = await db
    .select()
    .from(labAnalyses)
    .where(eq(labAnalyses.clientUuid, input.clientUuid))
    .limit(1);
  if (replay) return replay;

  const settings = await getActiveSettings();
  const computed = computeDeduction(
    { moistureBp: input.moistureBp, trashBp: input.trashBp },
    settings.deductionMode,
    settings.norms,
  );

  const [row] = await db
    .insert(labAnalyses)
    .values({
      clientUuid: input.clientUuid,
      ticketId: input.ticketId ?? null,
      batchId: input.batchId ?? null,
      stage: input.stage ?? "on_intake",
      status: "DRAFT",
      moistureBp: input.moistureBp,
      trashBp: input.trashBp,
      // Freeze the mode and norms that were in force, so a later settings change
      // never silently restates an analysis that has already paid tickets.
      deductionMode: settings.deductionMode,
      normMoistureBp: settings.norms.moistureBp,
      normTrashBp: settings.norms.trashBp,
      computedDeductionBp: computed,
      storageNote: input.storageNote ?? null,
      sampledAt: input.sampledAt ?? new Date(),
      createdBy: input.labUserId,
    })
    .returning();
  if (!row) throw new Error("Could not record the analysis.");
  return row;
}

export interface ApproveAnalysisInput {
  analysisId: string;
  approverId: string;
  /** Lab head's override of the computed deduction. Requires a reason. */
  overrideDeductionBp?: number;
  overrideReason?: string;
}

/**
 * Approving is what makes cotton payable — a ticket cannot be paid until it has been
 * through the weighbridge AND the lab. docs/domain.md §3.
 *
 * A ticket analysis promotes that one truck. A партия analysis promotes every weighed
 * ticket in the lot that has no analysis of its own.
 *
 * An approved analysis is immutable. A re-analysis is a new row; tickets already paid
 * under the old one are never restated.
 */
export async function approveAnalysis(input: ApproveAnalysisInput) {
  return await db.transaction(async (tx) => {
    const [analysis] = await tx
      .select()
      .from(labAnalyses)
      .where(eq(labAnalyses.id, input.analysisId))
      .for("update")
      .limit(1);
    if (!analysis) throw new DomainError("Таҳлил ёфт нашуд. / Analysis not found.");
    if (analysis.status !== "DRAFT") {
      throw new DomainError(
        "Ин таҳлил аллакай тасдиқ шудааст ва тағйир дода намешавад. / " +
          "This analysis is already approved and cannot be changed.",
      );
    }

    if (input.overrideDeductionBp !== undefined) {
      if (!input.overrideReason?.trim()) {
        throw new DomainError(
          "Барои тағйир додани тарҳ сабаб ҳатмист. / An override requires a reason.",
        );
      }
      if (input.overrideDeductionBp < 0 || input.overrideDeductionBp >= 10_000) {
        throw new DomainError("Тарҳ бояд аз 0 то 100 % бошад. / Deduction must be 0–100 %.");
      }
    }

    const approvedAt = new Date();
    await tx
      .update(labAnalyses)
      .set({
        status: "APPROVED",
        approvedBy: input.approverId,
        approvedAt,
        overrideDeductionBp: input.overrideDeductionBp ?? null,
        overrideReason: input.overrideReason?.trim() ?? null,
      })
      .where(eq(labAnalyses.id, analysis.id));

    let promoted: { id: string }[] = [];

    if (analysis.stage === "on_intake") {
      if (analysis.ticketId) {
        // One truck. Guard the transition so a ticket that is not simply WEIGHED
        // (already paid, voided) is never quietly moved.
        const [ticket] = await tx
          .select({ id: weighTickets.id, status: weighTickets.status })
          .from(weighTickets)
          .where(eq(weighTickets.id, analysis.ticketId))
          .for("update")
          .limit(1);
        if (ticket && ticket.status === "WEIGHED") {
          const next = transition(ticket.status as TicketStatus, "APPROVE_ANALYSIS");
          await tx
            .update(weighTickets)
            .set({ status: next, analysedAt: approvedAt })
            .where(eq(weighTickets.id, ticket.id));
          promoted = [{ id: ticket.id }];
        }
      } else if (analysis.batchId) {
        // A whole lot. Tickets sampled individually keep their own result, so only the
        // ones with no analysis of their own are covered by this certificate.
        const sampled = await tx
          .select({ ticketId: labAnalyses.ticketId })
          .from(labAnalyses)
          .where(
            and(
              eq(labAnalyses.stage, "on_intake"),
              eq(labAnalyses.status, "APPROVED"),
              isNull(labAnalyses.supersededAt),
            ),
          );
        const excluded = sampled.map((s) => s.ticketId).filter(Boolean) as string[];

        promoted = await tx
          .update(weighTickets)
          .set({ status: "ANALYSED", analysedAt: approvedAt })
          .where(
            and(
              eq(weighTickets.batchId, analysis.batchId),
              inArray(weighTickets.status, ["WEIGHED"]),
            ),
          )
          .returning({ id: weighTickets.id });
        promoted = promoted.filter((p) => !excluded.includes(p.id));
      }
    }

    await tx.insert(auditLog).values({
      action: "lab.approve",
      entityTable: "lab_analyses",
      entityId: analysis.id,
      payload: {
        ticketId: analysis.ticketId,
        batchId: analysis.batchId,
        moistureBp: analysis.moistureBp,
        trashBp: analysis.trashBp,
        computedDeductionBp: analysis.computedDeductionBp,
        overrideDeductionBp: input.overrideDeductionBp ?? null,
        overrideReason: input.overrideReason ?? null,
        ticketsPromoted: promoted.length,
      },
      actorId: input.approverId,
      actorRole: "lab",
      occurredAt: approvedAt,
    });

    return {
      analysisId: analysis.id,
      effectiveDeductionBp: input.overrideDeductionBp ?? analysis.computedDeductionBp,
      ticketsPromoted: promoted.length,
    };
  });
}

/**
 * The approved analysis that decides what one ticket is paid.
 *
 * The truck's own sample wins. A партия certificate covers a truck that was not sampled
 * individually. Nothing else can make cotton payable.
 */
type Queryable = Pick<typeof db, "select">;

export async function analysisForTicket(
  tx: Queryable,
  ticketId: string,
  batchId: string | null,
) {
  const [own] = await tx
    .select()
    .from(labAnalyses)
    .where(
      and(
        eq(labAnalyses.ticketId, ticketId),
        eq(labAnalyses.stage, "on_intake"),
        eq(labAnalyses.status, "APPROVED"),
        isNull(labAnalyses.supersededAt),
      ),
    )
    .limit(1);
  if (own) return own;

  if (!batchId) return undefined;

  const [lot] = await tx
    .select()
    .from(labAnalyses)
    .where(
      and(
        eq(labAnalyses.batchId, batchId),
        eq(labAnalyses.stage, "on_intake"),
        eq(labAnalyses.status, "APPROVED"),
        isNull(labAnalyses.supersededAt),
      ),
    )
    .limit(1);
  return lot;
}
