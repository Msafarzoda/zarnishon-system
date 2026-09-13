import { z } from "zod";
import { handler } from "@/server/api";
import { markDeparted } from "@/server/services/tickets";

const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid(),
});

export const POST = handler({
  operation: "gate.depart",
  roles: ["guard", "weigher"],
  schema,
  run: async (input, user) => await markDeparted({ ...input, actorId: user.id }),
});
