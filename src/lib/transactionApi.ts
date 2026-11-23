import { z } from "zod";

/**
 * Request validation and response shaping for /api/transactions.
 *
 * The API speaks camelCase (like the existing `categoryId`); the database
 * columns are snake_case. Ledger rules: `amount` is your share and is what
 * totals use; `paidAmount` is the cash that left your account (null means
 * the same as amount); with a split, your share can't exceed the bill.
 */

const money = z.coerce.number().finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const TX_STATUSES = ["pending", "paid", "failed"] as const;
export const TX_SOURCES = ["manual", "upi", "sms", "chat", "recurring"] as const;

// New FIN-1 fields. All optional; null clears a nullable column.
const ledgerFields = {
  paidAmount: money.min(0, "paidAmount can't be negative").nullable().optional(),
  splitTotal: money.positive("splitTotal must be more than 0").nullable().optional(),
  splitPeople: z.coerce.number().int().min(2).max(20).nullable().optional(),
  splitPayer: z.string().trim().min(1).max(80).nullable().optional(),
  splitUneven: z.boolean().optional(),
  status: z.enum(TX_STATUSES).optional(),
  source: z.enum(TX_SOURCES).optional(),
  needsPurpose: z.boolean().optional(),
  payeeId: z.string().uuid().nullable().optional(),
};

const baseFields = {
  amount: money.min(0, "amount (your share) can't be negative"),
  type: z.enum(["income", "expense"]),
  categoryId: z.string().uuid(),
  date: isoDate,
  description: z.string().trim().max(500).nullable().optional(),
};

const shareWithinSplit = (v: { amount?: number; splitTotal?: number | null }) =>
  v.splitTotal == null || v.amount == null || v.amount <= v.splitTotal;
const shareMessage = { message: "amount (your share) can't be more than splitTotal", path: ["amount"] };

export const createTransactionSchema = z
  .object({ ...baseFields, ...ledgerFields })
  // A zero share is only valid on a split ("I know my share" can be 0).
  .refine((v) => v.amount > 0 || v.splitTotal != null, { message: "amount must be more than 0", path: ["amount"] })
  .refine(shareWithinSplit, shareMessage);

// PUT keeps its old contract (all base fields), plus the new optional ones.
export const replaceTransactionSchema = createTransactionSchema;

// PATCH: any subset of fields.
export const patchTransactionSchema = z
  .object({
    amount: baseFields.amount.optional(),
    type: baseFields.type.optional(),
    categoryId: baseFields.categoryId.optional(),
    date: baseFields.date.optional(),
    description: baseFields.description,
    ...ledgerFields,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" })
  .refine(shareWithinSplit, shareMessage);

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type PatchTransactionInput = z.infer<typeof patchTransactionSchema>;

const COLUMN: Record<string, string> = {
  amount: "amount",
  type: "type",
  categoryId: "category_id",
  date: "date",
  description: "description",
  paidAmount: "paid_amount",
  splitTotal: "split_total",
  splitPeople: "split_people",
  splitPayer: "split_payer",
  splitUneven: "split_uneven",
  status: "status",
  source: "source",
  needsPurpose: "needs_purpose",
  payeeId: "payee_id",
};

/** Maps validated camelCase input to DB columns, keeping only provided keys. */
export function toDbColumns(input: Partial<CreateTransactionInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || !(key in COLUMN)) continue;
    out[COLUMN[key]] = key === "description" && value === "" ? null : value;
  }
  return out;
}

/** Columns every transactions response selects. */
export const TX_SELECT =
  "id, date, type, amount, description, paid_amount, split_total, split_people, split_payer, split_uneven, status, source, needs_purpose, payee_id, transfer_direction, counterparty, categories(id, name, icon)";

const num = (v: unknown) => (v == null ? null : Number(v));

export function toApiTransaction(row: any) {
  const cat = Array.isArray(row.categories) ? row.categories[0] : row.categories;
  return {
    id: row.id as string,
    date: row.date as string,
    type: row.type as "income" | "expense" | "transfer",
    amount: Number(row.amount),
    description: (row.description ?? null) as string | null,
    category: cat ? { id: cat.id as string, name: cat.name as string, icon: cat.icon as string } : null,
    paidAmount: num(row.paid_amount),
    splitTotal: num(row.split_total),
    splitPeople: num(row.split_people),
    splitPayer: (row.split_payer ?? null) as string | null,
    splitUneven: Boolean(row.split_uneven),
    status: (row.status ?? "paid") as (typeof TX_STATUSES)[number],
    source: (row.source ?? "manual") as (typeof TX_SOURCES)[number],
    needsPurpose: Boolean(row.needs_purpose),
    payeeId: (row.payee_id ?? null) as string | null,
    transferDirection: (row.transfer_direction ?? null) as "in" | "out" | null,
    counterparty: (row.counterparty ?? null) as string | null,
  };
}

/** Turns a zod error into a 400 response with field messages. */
export function validationError(error: z.ZodError) {
  return Response.json(
    { error: "invalid_request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    { status: 400 }
  );
}
