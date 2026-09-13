import { z } from "zod";
import { handler } from "@/server/api";
import { createCounterparty } from "@/server/services/registry";

const schema = z.object({
  /** Station-generated. Doubles as the idempotency key. */
  id: z.string().uuid(),
  clientUuid: z.string().uuid(),
  kind: z.enum(["farm", "individual", "company"]).default("farm"),
  name: z.string().min(1).max(200),
  tin: z.string().max(20).optional(),
  defaultLocation: z.string().max(120).optional(),
  brigadeCode: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
});

export const POST = handler({
  operation: "counterparty.create",
  // The weigher is included deliberately: a farm delivering for the first time must not
  // stop the weighbridge. Every record he creates is listed for the owner to review.
  roles: ["weigher", "merchandiser", "cashier", "owner", "accountant", "admin"],
  schema,
  run: async (input, user) => await createCounterparty({ ...input, createdBy: user.id }),
});
