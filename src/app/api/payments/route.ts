import { z } from "zod";
import { handler } from "@/server/api";
import { payTicket } from "@/server/services/payments";

const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid(),
  copyCollected: z.boolean(),
  /** Diram to hand over now. Omit for the whole amount; 0 means "we will pay you later". */
  disburseD: z.number().int().min(0).optional(),
  paidAt: z.string().datetime().optional(),
  originatedOffline: z.boolean().optional(),
});

export const POST = handler({
  operation: "ticket.pay",
  roles: ["cashier"],
  schema,
  run: async (input, user) =>
    await payTicket({
      ...input,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
      cashierId: user.id,
      stationId: user.stationId ?? undefined,
    }),
});
