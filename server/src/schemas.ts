import { z } from "zod";

// Amounts are positive integers in the smallest currency unit (e.g. cents).
// No floats ever touch money.
export const legSchema = z.object({
  account: z.string().min(1),
  direction: z.enum(["debit", "credit"]),
  amount: z.number().int().positive(),
});

export const postTransactionSchema = z.object({
  idempotencyKey: z.string().min(1),
  description: z.string().max(500).optional(),
  // At least two legs — a single-leg "transaction" can never balance.
  legs: z.array(legSchema).min(2),
});

export type PostTransactionInput = z.infer<typeof postTransactionSchema>;
export type Leg = z.infer<typeof legSchema>;
