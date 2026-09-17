import { z } from "zod";
import { handler } from "@/server/api";
import { closeRun, openRun } from "@/server/services/production";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    clientUuid: z.string().uuid(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("close"),
    clientUuid: z.string().uuid(),
    runId: z.string().uuid(),
  }),
]);

export const POST = handler({
  operation: "production.run",
  // The молшинос runs the gin floor. The owner may act here too — on a small site he
  // often is the person who opens the shift.
  roles: ["merchandiser", "owner"],
  schema,
  run: async (input, user) =>
    input.action === "open"
      ? await openRun({
          clientUuid: input.clientUuid,
          operatorId: user.id,
          stationId: user.stationId,
          note: input.note ?? null,
        })
      : await closeRun(input.runId, user.id),
});
