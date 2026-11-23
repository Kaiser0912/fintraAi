import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { getSharedSummary } from "@/lib/server/sharedSummary";
export const dynamic = "force-dynamic";

// GET /api/shared?month=YYYY-MM — fronted / got back / friends covered /
// paid back for one month (defaults to the current month). Used by the
// Shared tab; the dashboard gets the current month inline.
export async function GET(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const param = new URL(req.url).searchParams.get("month");
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (param) {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(param);
    if (!m) return Response.json({ error: "invalid_request", message: "month must be YYYY-MM" }, { status: 400 });
    year = Number(m[1]);
    month = Number(m[2]);
  }

  try {
    const db = await getRequestDb();
    return Response.json(await getSharedSummary(db, user.id, year, month));
  } catch (error) {
    console.error("[GET /api/shared]", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
