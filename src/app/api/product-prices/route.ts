import { z } from "zod";
import { handler } from "@/server/api";
import { setProductPrice } from "@/server/services/product-pricing";

const schema = z.object({
  clientUuid: z.string().uuid(),
  product: z.enum(["chigit", "kip", "ulyuk", "puchoq"]),
  priceDPerKg: z.number().int().positive(),
  note: z.string().max(200).optional(),
});

export const POST = handler({
  operation: "product_price.set",
  // Only the owner. Checked again inside the service, because a price is the one number
  // everything else in the money path multiplies by.
  roles: ["owner"],
  schema,
  run: async (input, user) => await setProductPrice({ ...input, setBy: user.id }),
});
