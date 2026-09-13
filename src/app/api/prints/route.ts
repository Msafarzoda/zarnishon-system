import { z } from "zod";
import { handler } from "@/server/api";
import { recordPrint } from "@/server/services/printing";

const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid(),
  kind: z.enum(["borkhat", "tahlil"]).optional(),
  reason: z.string().max(300).optional(),
});

export const POST = handler({
  operation: "ticket.print",
  // Anyone who can legitimately hold the paper may print it; the control is the record,
  // not the permission. See src/server/services/printing.ts.
  roles: ["weigher", "lab", "merchandiser", "cashier", "accountant", "owner", "admin"],
  schema,
  run: async (input, user) =>
    await recordPrint({
      ...input,
      actorId: user.id,
      actorRole: user.role,
      stationId: user.stationId ?? undefined,
    }),
});
