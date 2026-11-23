import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { lastDueOnOrBefore } from "@/lib/recurring";
export const dynamic = "force-dynamic";

type TxType = "income" | "expense";

// POST — materialize any due recurring rules into real transactions.
// Idempotent: a rule only posts once per period, guarded by last_run_date.
export async function POST() {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const userId = user.id;

  const db = await getRequestDb();
  const today = new Date();

  const { data: rules, error } = await db
    .from("recurring_rules")
    .select("id, category_id, amount, type, description, day_of_month, last_run_date")
    .eq("user_id", userId)
    .eq("active", true);

  if (error) {
    console.error("[POST /api/recurring/run]", error);
    return new Response("Internal Server Error", { status: 500 });
  }

  let created = 0;

  for (const r of rules ?? []) {
    const due = lastDueOnOrBefore(today, r.day_of_month);
    // Already posted for this (or a later) period — skip.
    if (r.last_run_date && String(r.last_run_date) >= due) continue;

    const amount = Number(r.amount);
    const type = r.type as TxType;

    const { error: txErr } = await db.from("transactions").insert({
      user_id: userId,
      category_id: r.category_id,
      amount,
      type,
      date: due,
      description: r.description ?? null,
    });
    if (txErr) {
      console.error("[recurring materialize]", txErr);
      continue;
    }

    await db
      .from("recurring_rules")
      .update({ last_run_date: due, updated_at: new Date().toISOString() })
      .eq("id", r.id);

    created++;
  }

  return Response.json({ created });
}
