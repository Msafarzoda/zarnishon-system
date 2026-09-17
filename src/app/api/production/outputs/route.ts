import { z } from "zod";
import { handler } from "@/server/api";
import { recordOutput } from "@/server/services/production";

const schema = z.object({
  clientUuid: z.string().uuid(),
  runId: z.string().uuid(),
  /** Кип is refused by the service: a bale is pressed, never poured onto a heap. */
  product: z.enum(["chigit", "ulyuk", "puchoq", "kip"]),
  weightG: z.number().int().positive(),
  storageLocationId: z.string().uuid().optional(),
  weighSource: z.enum(["manual", "indicator"]).optional(),
  indicatorRaw: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "production.output",
  roles: ["merchandiser", "weigher"],
  schema,
  run: async (input, user) => await recordOutput({ ...input, operatorId: user.id }),
});
