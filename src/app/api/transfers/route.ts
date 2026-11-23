import { z } from "zod";
import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { toApiTransaction, TX_SELECT, validationError } from "@/lib/transactionApi";
import { dbErrorResponse } from "@/lib/dbErrors";
import { getSharedSummary } from "@/lib/server/sharedSummary";
export const dynamic = "force-dynamic";

// Settle up: "I got money back" (in) or "I paid someone back" (out).
// Saved as a transfer, so it never counts as income or spending.
const settleUpSchema = z.object({
  direction: z.enum(["in", "out"]),
  counterparty: z.string().trim().min(1, "who is required").max(80),
  amount: z.coerce.number().finite().positive("amount must be more than 0"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  description: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const parsed = settleUpSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { direction, counterparty, amount, date, description } = parsed.data;

  const db = await getRequestDb();
  const { data, error } = await db
    .from("transactions")
    .insert({
      user_id: user.id,
      type: "transfer",
      transfer_direction: direction,
      counterparty,
      amount,
      date,
      description: description || null,
      category_id: null,
    })
    .select(TX_SELECT)
    .single();

  if (error) return dbErrorResponse("POST /api/transfers", error);

  const [y, m] = date.split("-").map(Number);
  const summary = await getSharedSummary(db, user.id, y, m);

  return Response.json({ transfer: toApiTransaction(data), summary }, { status: 201 });
}
