import { z } from "zod";
import { handler } from "@/server/api";
import { createTicket } from "@/server/services/tickets";

const schema = z.object({
  clientUuid: z.string().uuid(),
  season: z.number().int(),
  consignorId: z.string().uuid(),
  payerId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  varietyId: z.string().uuid().optional(),
  grade: z.number().int().min(1).max(5).optional(),
  cottonClass: z.string().max(8).optional(),
  loadingPlace: z.string().max(120).optional(),
  unloadingPlace: z.string().max(120).optional(),
  routeNo: z.string().max(40).optional(),
  originatedOffline: z.boolean().optional(),
});

export const POST = handler({
  operation: "ticket.create",
  roles: ["weigher", "merchandiser"],
  schema,
  run: async (input, user) => {
    if (!user.stationId) {
      throw new Error("Ҷойгоҳ интихоб нашудааст. / No station selected for this session.");
    }
    const ticket = await createTicket({ ...input, stationId: user.stationId, createdBy: user.id });
    return { ticketId: ticket.id, serial: ticket.serial, status: ticket.status };
  },
});
