import { z } from "zod";
import { handler } from "@/server/api";
import { approveAnalysis } from "@/server/services/lab";

const schema = z.object({
  clientUuid: z.string().uuid(),
  analysisId: z.string().uuid(),
  overrideDeductionBp: z.number().int().min(0).max(9_999).optional(),
  overrideReason: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "lab.analysis.approve",
  roles: ["lab"],
  schema,
  run: async (input, user) =>
    await approveAnalysis({ ...input, approverId: user.id }),
});
