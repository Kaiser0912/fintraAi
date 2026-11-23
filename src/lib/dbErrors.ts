/**
 * Maps Postgres errors from Supabase to HTTP responses. Rule violations the
 * caller can fix (a check constraint, a payee that isn't theirs) become 400s
 * with a readable message; anything else stays a logged 500.
 */
const FRIENDLY: Record<string, string> = {
  transactions_share_within_split_check: "amount (your share) can't be more than splitTotal",
  transactions_paid_amount_check: "paidAmount can't be negative",
  transactions_split_total_check: "splitTotal must be more than 0",
  transactions_split_people_check: "splitPeople must be between 2 and 20",
  transactions_status_check: "status must be pending, paid or failed",
  transactions_source_check: "source is not a known value",
  transactions_payee_fkey: "payeeId is not one of your payees",
};

export function dbErrorResponse(where: string, error: { code?: string; message: string }) {
  if (error.code === "23514" || error.code === "23503") {
    const name = Object.keys(FRIENDLY).find((k) => error.message.includes(k));
    return Response.json(
      { error: "invalid_request", message: name ? FRIENDLY[name] : "value breaks a data rule" },
      { status: 400 }
    );
  }
  console.error(`[${where}]`, error);
  return new Response(`DB Error: ${error.message}`, { status: 500 });
}
