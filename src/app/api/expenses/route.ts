import { z } from "zod";
import { handler } from "@/server/api";
import { recordExpense } from "@/server/services/expenses";

const schema = z.object({
  clientUuid: z.string().uuid(),
  categoryId: z.string().uuid(),
  /** Integer diram. The screen parses сомонӣ; the wire carries diram. */
  amountD: z.number().int().positive(),
  note: z.string().max(300).optional(),
  occurredAt: z.string().datetime().optional(),
});

export const POST = handler({
  operation: "expense.record",
  roles: ["cashier", "owner", "accountant", "admin"],
  schema,
  run: async (input, user) =>
    await recordExpense({
      ...input,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
      recordedBy: user.id,
      stationId: user.stationId ?? undefined,
    }),
});
