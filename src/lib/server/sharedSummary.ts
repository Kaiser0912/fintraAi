import { type Db } from "@/utils/supabase/db";

/**
 * Money shared with friends for one month. None of these are income or
 * spending; they explain where cash went beyond your share.
 *
 *   fronted        what you paid for friends: paid_amount − amount on bills you paid
 *   gotBack        transfers in (friends paying you back)
 *   friendsCovered your share of bills someone else paid (split_payer set)
 *   paidBack       transfers out (you paying friends back)
 */
export interface SharedSummary {
  month: string; // YYYY-MM
  fronted: number;
  gotBack: number;
  friendsCovered: number;
  paidBack: number;
  /** fronted − gotBack: what friends still owe you this month (can be negative). */
  owedToYou: number;
  /** friendsCovered − paidBack: what you still owe friends this month. */
  youOwe: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthBounds(year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}`, label: `${year}-${pad(month)}` };
}

export async function getSharedSummary(db: Db, userId: string, year: number, month: number): Promise<SharedSummary> {
  const { start, end, label } = monthBounds(year, month);

  const { data, error } = await db
    .from("transactions")
    .select("type, amount, paid_amount, split_payer, transfer_direction")
    .eq("user_id", userId)
    .eq("status", "paid")
    .gte("date", start)
    .lte("date", end)
    .or("type.eq.transfer,split_payer.not.is.null,paid_amount.not.is.null");

  if (error) throw error;

  let fronted = 0, gotBack = 0, friendsCovered = 0, paidBack = 0;
  for (const r of data ?? []) {
    const amount = Number(r.amount);
    if (r.type === "transfer") {
      if (r.transfer_direction === "in") gotBack += amount;
      else if (r.transfer_direction === "out") paidBack += amount;
    } else if (r.type === "expense") {
      if (r.split_payer) friendsCovered += amount;
      else if (r.paid_amount != null && Number(r.paid_amount) > amount) fronted += Number(r.paid_amount) - amount;
    }
  }

  return {
    month: label,
    fronted: round2(fronted),
    gotBack: round2(gotBack),
    friendsCovered: round2(friendsCovered),
    paidBack: round2(paidBack),
    owedToYou: round2(fronted - gotBack),
    youOwe: round2(friendsCovered - paidBack),
  };
}
