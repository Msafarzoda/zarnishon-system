import { z } from "zod";
import { handler } from "@/server/api";
import { disburseCash } from "@/server/services/disbursements";

const schema = z.object({
  clientUuid: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  /** Diram. The service refuses more than the farm is owed or than the drawer holds. */
  amountD: z.number().int().positive(),
  note: z.string().max(200).optional(),
  paidAt: z.string().datetime().optional(),
  originatedOffline: z.boolean().optional(),
});

export const POST = handler({
  operation: "cash.disburse",
  roles: ["cashier"],
  schema,
  run: async (input, user) =>
    await disburseCash({
      ...input,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
      cashierId: user.id,
      stationId: user.stationId ?? undefined,
    }),
});
