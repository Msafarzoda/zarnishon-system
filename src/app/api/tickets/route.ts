import { z } from "zod";
import { handler } from "@/server/api";
import { DomainError } from "@/domain/units";
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
  /** The loaded weighing, recorded with the ticket rather than in a second call. */
  gross: z
    .object({
      clientUuid: z.string().uuid(),
      weightG: z.number().int().positive().max(2 ** 31 - 1),
      source: z.enum(["manual", "indicator"]).optional(),
      indicatorRaw: z.string().max(256).optional(),
      reason: z.string().max(500).optional(),
      capturedAt: z.string().datetime().optional(),
      deviceFingerprint: z.string().max(128).optional(),
    })
    .optional(),
});

export const POST = handler({
  operation: "ticket.create",
  roles: ["weigher", "merchandiser"],
  schema,
  run: async (input, user) => {
    if (!user.stationId) {
      throw new DomainError(
        "Ҷойгоҳ интихоб нашудааст. Бароед ва ҳангоми даромадан ҷойгоҳро интихоб кунед. / " +
          "No station chosen for this session — sign out and pick one.",
      );
    }
    const ticket = await createTicket({
      ...input,
      gross: input.gross
        ? {
            ...input.gross,
            capturedAt: input.gross.capturedAt ? new Date(input.gross.capturedAt) : undefined,
          }
        : undefined,
      stationId: user.stationId,
      createdBy: user.id,
    });
    return {
      ticketId: ticket.id,
      serial: ticket.serial,
      status: ticket.status,
      grossG: ticket.grossG,
    };
  },
});
