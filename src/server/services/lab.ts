import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, labAnalyses, weighTickets } from "@/db/schema/index";
import { DomainError } from "@/domain/units";
import { deductionBp as computeDeduction } from "@/domain/weight";
import { getActiveSettings } from "./settings.js";

export interface CreateAnalysisInput {
  clientUuid: string;
  batchId: string;
  stage?: "on_intake" | "on_dispatch";
  moistureBp: number;
  trashBp: number;
  storageNote?: string;
  sampledAt?: Date;
  labUserId: string;
}

/** Enter a Форма №9-хл reading. Stays DRAFT until the lab head approves it. */
export async function createAnalysis(input: CreateAnalysisInput) {
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
      batchId: input.batchId,
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
 * Approving an analysis is what makes a партия payable: every ticket in it that has
 * been weighed moves WEIGHED → ANALYSED in the same transaction.
 *
 * An approved analysis is immutable. A re-analysis is a new row; tickets already paid
 * under the old one are never restated. docs/domain.md §3.
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

    // Make every weighed ticket in this партия payable.
    let promoted: { id: string }[] = [];
    if (analysis.stage === "on_intake") {
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
    }

    await tx.insert(auditLog).values({
      action: "lab.approve",
      entityTable: "lab_analyses",
      entityId: analysis.id,
      payload: {
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
