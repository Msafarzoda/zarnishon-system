import { z } from "zod";
import { handler } from "@/server/api";
import { previewFarmPayment } from "@/server/services/farm-payment";

/**
 * What settling this farm for an amount would come to. Reads only — nothing is posted —
 * but it still needs the cashier's role, because the plan discloses what a farm is owed.
 */
const schema = z.object({
  counterpartyId: z.string().uuid(),
  requestedCashD: z.number().int().min(0).nullable(),
});

export const POST = handler({
  operation: "farm.pay.preview",
  roles: ["cashier", "owner", "accountant", "admin"],
  schema,
  run: async (input) =>
    await previewFarmPayment({
      counterpartyId: input.counterpartyId,
      requestedCashD: input.requestedCashD,
    }),
});
