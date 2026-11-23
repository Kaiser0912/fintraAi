import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { validationError } from "@/lib/transactionApi";
import { PAYEE_SELECT, rememberPayee, savePayeeSchema, toApiPayee } from "@/lib/payeeApi";
export const dynamic = "force-dynamic";

// GET /api/payees — saved payees, most recently paid first.
export async function GET(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 20) || 20, 1), 100);
  const db = await getRequestDb();
  const { data, error } = await db
    .from("payees")
    .select(PAYEE_SELECT)
    .eq("user_id", user.id)
    .order("last_paid_at", { ascending: false, nullsFirst: false })
    .order("name")
    .limit(limit);

  if (error) {
    console.error("[GET /api/payees]", error);
    return new Response("Internal Server Error", { status: 500 });
  }
  return Response.json({ data: (data ?? []).map(toApiPayee) });
}

// POST /api/payees — save or update a payee (one row per UPI ID).
export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const parsed = savePayeeSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  const db = await getRequestDb();
  const saved = await rememberPayee(db, parsed.data);
  if ("error" in saved) return Response.json({ error: "invalid_request", message: saved.error }, { status: 400 });

  const { data } = await db.from("payees").select(PAYEE_SELECT).eq("id", saved.id).single();
  return Response.json(toApiPayee(data), { status: 201 });
}
