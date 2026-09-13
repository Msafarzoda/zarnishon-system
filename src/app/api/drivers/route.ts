import { z } from "zod";
import { handler } from "@/server/api";
import { createDriver } from "@/server/services/registry";

const schema = z.object({
  id: z.string().uuid(),
  clientUuid: z.string().uuid(),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
});

export const POST = handler({
  operation: "driver.create",
  roles: ["weigher", "merchandiser", "owner", "admin"],
  schema,
  run: async (input, user) => await createDriver({ ...input, createdBy: user.id }),
});
