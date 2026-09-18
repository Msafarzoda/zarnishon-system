import { z } from "zod";
import { handler } from "@/server/api";
import { createExpenseCategory } from "@/server/services/expenses";

const schema = z.object({
  clientUuid: z.string().uuid().optional(),
  nameTg: z.string().min(1).max(120),
});

export const POST = handler({
  operation: "expense-category.create",
  roles: ["cashier", "owner", "accountant", "admin"],
  schema,
  run: async (input, user) =>
    await createExpenseCategory({ nameTg: input.nameTg, createdBy: user.id }),
});
