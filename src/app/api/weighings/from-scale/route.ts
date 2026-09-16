import { z } from "zod";
import { handler } from "@/server/api";
import { DomainError } from "@/domain/units";
import { captureWeight } from "@/server/services/tickets";
import { ensureScaleReader, getScaleSnapshot, releaseHold } from "@/server/scale/reader";

/**
 * Capture the weight the **server** is reading.
 *
 * Note what this schema does not contain: a weight. The station says which ticket and
 * whether it is брутто or тара, and the server supplies the number from the port it is
 * holding. There is nothing here for a page to forge, and no version of the request that
 * could carry a different figure from the one on the indicator.
 *
 * That is the whole reason for reading the scale on the server. With Web Serial the
 * browser reads the port and hands the server a number, and the server has to take its
 * word; here it does not. docs/domain.md §2.
 */
const schema = z.object({
  clientUuid: z.string().uuid(),
  ticketId: z.string().uuid(),
  kind: z.enum(["GROSS", "TARE"]),
  supersedesId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});

export const POST = handler({
  operation: "ticket.weigh.fromScale",
  roles: ["weigher"],
  schema,
  run: async (input, user) => {
    if (!user.stationId) {
      throw new DomainError(
        "Ҷойгоҳ интихоб нашудааст. Бароед ва ҳангоми даромадан ҷойгоҳро интихоб кунед. / " +
          "No station chosen for this session — sign out and pick one.",
      );
    }

    ensureScaleReader();
    const scale = getScaleSnapshot();

    if (!scale.connected) {
      throw new DomainError(
        "Тарозу пайваст нест. / The scale is not connected to the server.",
      );
    }
    if (scale.stale) {
      throw new DomainError(
        "Аз тарозу маълумот намеояд. / The scale has stopped sending — check the cable.",
      );
    }

    /*
     * The latched settled reading, not whatever the last frame happened to say. A loaded
     * truck rocks on its springs for several seconds and the button gets pressed during
     * it; taking the live value would record whichever moment that was.
     */
    const held = scale.held;
    if (!held) {
      throw new DomainError(
        "Вазн ҳанӯз устувор нашудааст — интизор шавед. / The platform has not settled yet.",
      );
    }

    const result = await captureWeight({
      clientUuid: input.clientUuid,
      ticketId: input.ticketId,
      kind: input.kind,
      weightG: held.weightG,
      source: "indicator",
      indicatorRaw: held.raw,
      capturedAt: new Date(),
      operatorId: user.id,
      stationId: user.stationId,
      supersedesId: input.supersedesId,
      reason: input.reason,
      deviceFingerprint: `server:${scale.path ?? "?"}`,
    });

    // Ready for the next truck; without this the same latched weight stays capturable.
    releaseHold();

    return { ...result, weightG: held.weightG, raw: held.raw };
  },
});
