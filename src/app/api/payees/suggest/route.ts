import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { PAYEE_SELECT, toApiPayee } from "@/lib/payeeApi";
export const dynamic = "force-dynamic";

// GET /api/payees/suggest?upi=shop@ybl — what the Pay screen needs for a
// scanned UPI ID: the saved payee (if any), its last 3 purposes as chips,
// and the category to pre-select.
export async function GET(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const upi = (new URL(req.url).searchParams.get("upi") ?? "").trim().toLowerCase();
  if (!upi) return Response.json({ error: "invalid_request", message: "upi is required" }, { status: 400 });

  const db = await getRequestDb();
  const { data, error } = await db
    .from("payees")
    .select(PAYEE_SELECT)
    .eq("user_id", user.id)
    .eq("upi_id", upi)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/payees/suggest]", error);
    return new Response("Internal Server Error", { status: 500 });
  }
  if (!data) return Response.json({ payee: null, purposes: [], category: null });

  const payee = toApiPayee(data);
  return Response.json({ payee, purposes: payee.recentPurposes.slice(0, 3), category: payee.defaultCategory });
}
