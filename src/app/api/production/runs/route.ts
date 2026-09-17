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
  /*
   * The молшинос runs the gin floor, and the owner does not — deliberately.
   *
   * The mass balance is what stands behind every hand-typed bale weight, and it is only
   * a control while the person recording the outputs is not the person who profits from
   * understating them. On a shift with no молшинос the answer is to grant somebody the
   * role in Идора, which is recorded, rather than to have the owner quietly hold it for
   * ever. docs/domain.md §6.
   */
  roles: ["merchandiser"],
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
