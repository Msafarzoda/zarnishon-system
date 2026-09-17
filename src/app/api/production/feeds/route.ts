import { z } from "zod";
import { handler } from "@/server/api";
import { recordFeed } from "@/server/services/production";

const schema = z.object({
  clientUuid: z.string().uuid(),
  runId: z.string().uuid(),
  weightG: z.number().int().positive(),
  batchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  varietyId: z.string().uuid().optional(),
  source: z.enum(["primary", "recycled"]).optional(),
  weighSource: z.enum(["manual", "indicator"]).optional(),
  indicatorRaw: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "production.feed",
  // The weigher is here because the бунт is emptied past his bridge, not the owner.
  roles: ["merchandiser", "weigher"],
  schema,
  run: async (input, user) => await recordFeed({ ...input, operatorId: user.id }),
});
