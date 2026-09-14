import { z } from "zod";
import { handler } from "@/server/api";
import { recordPrint } from "@/server/services/printing";

const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid().optional(),
  paymentId: z.string().uuid().optional(),
  kind: z.enum(["borkhat", "tahlil", "pardokht"]).optional(),
  reason: z.string().max(300).optional(),
}).refine((v) => !v.ticketId !== !v.paymentId, {
  message: "Exactly one of ticketId or paymentId must be given",
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
