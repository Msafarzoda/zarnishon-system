import { z } from "zod";
import { handler } from "@/server/api";
import { createAnalysis } from "@/server/services/lab";

const schema = z.object({
  clientUuid: z.string().uuid(),
  /** The truck this sample came from — the normal case. */
  ticketId: z.string().uuid().optional(),
  /** Or a whole партия certified at once. Exactly one of the two. */
  batchId: z.string().uuid().optional(),
  stage: z.enum(["on_intake", "on_dispatch"]).optional(),
  /** Basis points: 9 % arrives as 900. */
  moistureBp: z.number().int().min(0).max(10_000),
  trashBp: z.number().int().min(0).max(10_000),
  storageNote: z.string().max(200).optional(),
  sampledAt: z.string().datetime().optional(),
}).refine((v) => !v.ticketId !== !v.batchId, {
  message: "Exactly one of ticketId or batchId must be given",
});

export const POST = handler({
  operation: "lab.analysis.create",
  roles: ["lab"],
  schema,
  run: async (input, user) => {
    const row = await createAnalysis({
      ...input,
      sampledAt: input.sampledAt ? new Date(input.sampledAt) : undefined,
      labUserId: user.id,
    });
    return { analysisId: row.id, computedDeductionBp: row.computedDeductionBp };
  },
});
