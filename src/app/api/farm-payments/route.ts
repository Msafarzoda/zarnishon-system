import { z } from "zod";
import { handler } from "@/server/api";
import { payFarm } from "@/server/services/farm-payment";

const schema = z.object({
  clientUuid: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  /** Diram the farm asked for. Null settles everything it has ready. */
  requestedCashD: z.number().int().min(0).nullable(),
  copyCollected: z.boolean(),
  paidAt: z.string().datetime().optional(),
  originatedOffline: z.boolean().optional(),
});

export const POST = handler({
  operation: "farm.pay",
  roles: ["cashier"],
  schema,
  run: async (input, user) =>
    await payFarm({
      ...input,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
      cashierId: user.id,
      stationId: user.stationId ?? undefined,
    }),
});
