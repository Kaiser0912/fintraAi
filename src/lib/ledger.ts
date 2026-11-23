/**
 * Ledger rules shared by API routes, the dashboard and the chat agent.
 *
 * Transaction types:
 *   income / expense — counted in totals, budgets, charts and history.
 *   transfer         — money moving between you and someone else (settle-ups,
 *                      lending). Never counted as income or spending.
 */
export type TransactionType = "income" | "expense" | "transfer";
export type CountedType = "income" | "expense";
export type TransferDirection = "in" | "out";

/** True when a row of this type affects income/spending totals and history. */
export function countsInTotals(type: string | null | undefined): type is CountedType {
  return type === "income" || type === "expense";
}
