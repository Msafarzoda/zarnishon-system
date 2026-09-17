import { z } from "zod";
import { handler } from "@/server/api";
import { pressBale } from "@/server/services/production";

const schema = z.object({
  clientUuid: z.string().uuid(),
  runId: z.string().uuid(),
  batchId: z.string().uuid(),
  weightG: z.number().int().positive(),
  grade: z.string().max(40).optional(),
  storageLocationId: z.string().uuid().optional(),
});

export const POST = handler({
  operation: "bale.press",
  roles: ["merchandiser", "weigher"],
  schema,
  run: async (input, user) =>
    await pressBale({ ...input, operatorId: user.id, stationId: user.stationId }),
});
