import { z } from "zod";
import { handler } from "@/server/api";
import { sellProduct } from "@/server/services/product-sales";

const schema = z.object({
  clientUuid: z.string().uuid(),
  product: z.enum(["chigit", "kip", "ulyuk", "puchoq"]),
  buyerId: z.string().uuid(),
  /** Bulk: тара then брутто, grams. The lorry arrived empty. */
  tareG: z.number().int().nonnegative().optional(),
  grossG: z.number().int().positive().optional(),
  tareSource: z.enum(["manual", "indicator"]).optional(),
  grossSource: z.enum(["manual", "indicator"]).optional(),
  tareRaw: z.string().max(200).optional(),
  grossRaw: z.string().max(200).optional(),
  weighReason: z.string().max(500).optional(),
  vehicleId: z.string().uuid().optional(),
  /** Кип: the bales scanned onto the lorry. */
  baleIds: z.array(z.string().uuid()).max(500).optional(),
  /** Cash handed over at the gate. Omit for a sale on credit. */
  paidNowD: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "product.sell",
  // The молшинос loads and weighs. A cashier never can: the person who takes the money
  // does not also get to say what left the yard — and nor does the owner, for the same
  // reason the gin floor is not his. docs/domain.md §6.
  roles: ["merchandiser"],
  schema,
  run: async (input, user) =>
    await sellProduct({ ...input, soldBy: user.id, stationId: user.stationId }),
});
