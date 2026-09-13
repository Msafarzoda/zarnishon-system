import { z } from "zod";
import { handler } from "@/server/api";
import { issueAdvance } from "@/server/services/advances";

const schema = z.object({
  clientUuid: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  /** Integer diram. The screen parses сомонӣ; the wire carries diram. */
  principalD: z.number().int().positive(),
  purpose: z.string().max(200).optional(),
});

export const POST = handler({
  operation: "advance.issue",
  roles: ["cashier"],
  schema,
  run: async (input, user) =>
    await issueAdvance({ ...input, issuedBy: user.id, stationId: user.stationId ?? undefined }),
});
