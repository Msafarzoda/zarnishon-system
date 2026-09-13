import { z } from "zod";
import { handler } from "@/server/api";
import { captureWeight } from "@/server/services/tickets";

const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid(),
  kind: z.enum(["GROSS", "TARE"]),
  /** Integer grams. The screen parses the operator's kilograms; the wire carries grams. */
  weightG: z.number().int().nonnegative().max(2 ** 31 - 1),
  capturedAt: z.string().datetime().optional(),
  source: z.enum(["manual", "indicator"]).optional(),
  photoRef: z.string().max(512).optional(),
  indicatorRaw: z.string().max(256).optional(),
  deviceFingerprint: z.string().max(128).optional(),
  originatedOffline: z.boolean().optional(),
  supersedesId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "ticket.weigh",
  roles: ["weigher"],
  schema,
  run: async (input, user) => {
    if (!user.stationId) {
      throw new Error("Ҷойгоҳ интихоб нашудааст. / No station selected for this session.");
    }
    return await captureWeight({
      ...input,
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : undefined,
      operatorId: user.id,
      stationId: user.stationId,
    });
  },
});
