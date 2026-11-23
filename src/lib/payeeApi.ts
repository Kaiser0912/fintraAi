import { z } from "zod";
import { type Db } from "@/utils/supabase/db";

/** A payee as the API returns it. */
export function toApiPayee(row: any) {
  const cat = Array.isArray(row.categories) ? row.categories[0] : row.categories;
  return {
    id: row.id as string,
    name: row.name as string,
    upiId: row.upi_id as string,
    kind: row.kind as "merchant" | "personal",
    defaultCategoryId: (row.default_category_id ?? null) as string | null,
    defaultCategory: cat ? { id: cat.id as string, name: cat.name as string, icon: cat.icon as string } : null,
    recentPurposes: (row.recent_purposes ?? []) as string[],
    lastPaidAt: (row.last_paid_at ?? null) as string | null,
  };
}

export const PAYEE_SELECT =
  "id, name, upi_id, kind, default_category_id, recent_purposes, last_paid_at, categories(id, name, icon)";

/** Payee details sent with a payment (or saved on their own). */
export const payeeInputSchema = z.object({
  upiId: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,255}@[a-z0-9]{2,64}$/, "not a valid UPI ID"),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["merchant", "personal"]).optional(),
});

export const savePayeeSchema = payeeInputSchema.extend({
  categoryId: z.string().uuid().nullable().optional(),
  purpose: z.string().trim().max(120).nullable().optional(),
});

/**
 * Saves or updates a payee and records the purpose (remember_payee in the
 * database). Returns the payee id, or an error message.
 */
export async function rememberPayee(
  db: Db,
  input: z.infer<typeof savePayeeSchema>
): Promise<{ id: string } | { error: string }> {
  const { data, error } = await db.rpc("remember_payee", {
    p_upi_id: input.upiId,
    p_name: input.name,
    p_kind: input.kind ?? null,
    p_category_id: input.categoryId ?? null,
    p_purpose: input.purpose ?? null,
  });
  if (error || !data) return { error: error?.message ?? "could not save payee" };
  return { id: (data as { id: string }).id };
}
