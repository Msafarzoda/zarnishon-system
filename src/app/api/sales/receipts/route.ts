import { z } from "zod";
import { handler } from "@/server/api";
import { receiveSalePayment } from "@/server/services/product-sales";

const schema = z.object({
  clientUuid: z.string().uuid(),
  buyerId: z.string().uuid(),
  amountD: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "product.receipt",
  // Money coming in is the cash desk's, exactly like money going out.
  roles: ["cashier"],
  schema,
  run: async (input, user) =>
    await receiveSalePayment({ ...input, receivedBy: user.id, stationId: user.stationId }),
});
