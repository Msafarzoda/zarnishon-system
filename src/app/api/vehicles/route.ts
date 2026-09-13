import { z } from "zod";
import { handler } from "@/server/api";
import { createVehicle } from "@/server/services/registry";
import { TRANSPORT_ORGS } from "@/domain/plate";

const schema = z.object({
  id: z.string().uuid(),
  clientUuid: z.string().uuid(),
  plate: z.string().min(1).max(40),
  model: z.string().max(80).optional(),
  /** Хусусӣ or Ширкатӣ — nothing else. */
  transportOrg: z.enum(TRANSPORT_ORGS).optional(),
});

export const POST = handler({
  operation: "vehicle.create",
  roles: ["weigher", "merchandiser", "owner", "admin"],
  schema,
  run: async (input, user) => await createVehicle({ ...input, createdBy: user.id }),
});
