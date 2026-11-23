import { tool } from "@langchain/core/tools";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { dbForToken, type Db } from "@/utils/supabase/db";
import { getSharedSummary } from "@/lib/server/sharedSummary";
import { hitlTools } from "./hitlTools";
import { lastDueOnOrBefore, nextDueAfter, ordinal } from "@/lib/recurring";

// ─── Internal types ────────────────────────────────────────────────────────────

type DbClient = Db;

// Tools query as the signed-in user: runChat passes the access token in
// configurable, so Row Level Security applies to every agent read and write.
function dbFromConfig(config?: RunnableConfig): DbClient {
  const token = (config as { configurable?: { accessToken?: string } } | undefined)?.configurable?.accessToken;
  if (!token) throw new Error("Not signed in");
  return dbForToken(token);
}
type TransactionType = "income" | "expense";

// Shared param for read tools: "display" opts into the deterministic render
// fast-path (the app shows the result as a table, no follow-up LLM call);
// anything else routes the result back to the agent. See graph.ts afterTools.
const purposeParam = z
  .enum(["display", "lookup"])
  .optional()
  .describe(
    "'display' when the user just wants to see this data (the app renders it as a table automatically and your turn ends); 'lookup' when you need the data for analysis, advice, or a follow-up action"
  );

// ─── Category resolver ─────────────────────────────────────────────────────────

async function resolveCategoryId(
  db: DbClient,
  categoryName: string,
  type: TransactionType
): Promise<{ id: string; name: string } | null> {
  const { data } = await db
    .from("categories")
    .select("id, name")
    .eq("type", type)
    .eq("hidden", false);

  if (!data?.length) return null;

  const lower = categoryName.toLowerCase();

  return (
    data.find((c) => c.name.toLowerCase() === lower) ??
    data.find((c) => c.name.toLowerCase().includes(lower)) ??
    data.find((c) => lower.includes(c.name.toLowerCase())) ??
    null
  );
}

// ─── Tool: get_categories ──────────────────────────────────────────────────────

export const getCategoriesToolDef = tool(
  async (
    { type }: { type?: "income" | "expense" | "all" },
    config?: RunnableConfig
  ): Promise<string> => {
    const db = dbFromConfig(config);
    let query = db.from("categories").select("id, name, icon, type").eq("hidden", false).order("name");
    if (type && type !== "all") query = (query as any).eq("type", type);

    const { data, error } = await query;
    if (error) return `Error: ${error.message}`;

    const income = (data ?? []).filter((c) => c.type === "income");
    const expense = (data ?? []).filter((c) => c.type === "expense");

    return JSON.stringify({
      incomeCategories: income.map((c) => ({ id: c.id, name: c.name })),
      expenseCategories: expense.map((c) => ({ id: c.id, name: c.name })),
    });
  },
  {
    name: "get_categories",
    description:
      "Get all available income and expense categories. Call this when you are unsure which category to use for a transaction.",
    schema: z.object({
      type: z
        .enum(["income", "expense", "all"])
        .optional()
        .describe("Filter by category type, or omit for all"),
    }),
  }
);

// ─── Tool: add_transactions (single + bulk merged, Phase D) ─────────────────────

const txItemSchema = z.object({
  amount: z.number().min(0).optional().describe("Amount in ₹. For a shared bill, omit and use totalBill instead."),
  // Shared bills only — the tool works out the user's share; don't do the maths.
  totalBill: z.number().positive().optional().describe("Shared bill: the whole bill in ₹ before splitting"),
  people: z.number().int().min(2).max(20).optional().describe("Shared bill: how many people share it, including the user"),
  myShare: z.number().min(0).optional().describe("Shared bill: the user's share in ₹ when they state it ('my share 350')"),
  paidBy: z.string().optional().describe("Shared bill: who paid — omit if the user paid, else the friend's name"),
  // Some models nest the same fields under "split"; accept that shape too.
  split: z
    .object({
      totalBill: z.number().positive().optional(),
      people: z.number().int().min(2).max(20).optional(),
      myShare: z.number().min(0).optional(),
      paidBy: z.string().optional(),
    })
    .optional()
    .describe("Optional alternative: the same shared-bill fields nested here"),
  type: z.enum(["income", "expense"]),
  categoryName: z
    .string()
    .describe("Category name e.g. Food, Travel, Salary. Will be fuzzy-matched."),
  date: z
    .string()
    .describe("Date as YYYY-MM-DD. Convert relative dates to absolute."),
  description: z.string().optional().describe("Optional note or description"),
});

export const addTransactionsToolDef = tool(
  async (
    { transactions }: { transactions: z.infer<typeof txItemSchema>[] },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";

    const db = dbFromConfig(config);
    const messages: string[] = [];
    const errors: string[] = [];
    const skipped: string[] = [];
    // Rows saved by an EARLIER add_transactions call in this same chat turn.
    // Some models call the tool again after it already succeeded; identical
    // rows from that repeat are skipped. Rows within one call never dedupe
    // each other (two identical coffees in one message both save), and other
    // turns are never affected.
    const callStart = new Date();
    const turnStartedAt = (config as any)?.configurable?.turnStartedAt as string | undefined;
    const { data: recentRows } = turnStartedAt
      ? await db
          .from("transactions")
          .select("amount, type, category_id, date, description, split_total, split_payer")
          .eq("user_id", userId)
          .gte("created_at", turnStartedAt)
          .lt("created_at", callStart.toISOString())
      : { data: [] };
    const recent = new Map<string, number>();
    const keyOf = (r: { amount: unknown; type: unknown; category_id: unknown; date: unknown; description: unknown; split_total: unknown; split_payer: unknown }) =>
      [Number(r.amount), r.type, r.category_id, r.date, (r.description ?? "").toString().trim().toLowerCase(), r.split_total == null ? "" : Number(r.split_total), r.split_payer ?? ""].join("|");
    for (const r of recentRows ?? []) recent.set(keyOf(r), (recent.get(keyOf(r)) ?? 0) + 1);

    for (const tx of transactions) {
      const shared = splitFields(tx);
      if ("error" in shared) {
        errors.push(shared.error);
        continue;
      }
      const category = await resolveCategoryId(db, tx.categoryName, tx.type);
      if (!category) {
        const { data: cats } = await db
          .from("categories")
          .select("name")
          .eq("type", tx.type)
    .eq("hidden", false);
        errors.push(
          `Category "${tx.categoryName}" not found for ${tx.type}. Available: ${cats?.map((c) => c.name).join(", ") ?? "none"}`
        );
        continue;
      }

      const key = keyOf({
        amount: shared.columns.amount, type: tx.type, category_id: category.id, date: tx.date,
        description: tx.description ?? null, split_total: shared.columns.split_total ?? null, split_payer: shared.columns.split_payer ?? null,
      });
      const seen = recent.get(key) ?? 0;
      if (seen > 0) {
        recent.set(key, seen - 1);
        skipped.push(`₹${shared.columns.amount} ${category.name} on ${tx.date} (already added a moment ago)`);
        continue;
      }

      const { error } = await db
        .from("transactions")
        .insert({
          user_id: userId,
          category_id: category.id,
          type: tx.type,
          date: tx.date,
          description: tx.description ?? null,
          ...shared.columns,
        })
        .select("id")
        .single();

      if (error) {
        errors.push(`₹${shared.columns.amount} ${category.name}: ${error.message}`);
        continue;
      }

      messages.push(
        `Added ${tx.type} of ₹${shared.columns.amount} in ${category.name} on ${tx.date}${shared.note}${tx.description ? ` — "${tx.description}"` : ""}`
      );
    }

    if (errors.length) console.warn("[add_transactions] rejected rows", errors);
    return JSON.stringify({
      added: messages.length,
      failed: errors.length,
      messages,
      ...(skipped.length ? { skipped, note: "These were already saved by your previous call — do not add them again." } : {}),
      ...(errors.length ? { errors } : {}),
    });
  },
  {
    name: "add_transactions",
    description:
      "Add income/expense transactions. Pass the ENTIRE list the user gave in ONE call (up to 50 rows). Never truncate or stop at a partial batch — every row the user listed must be in this call. For a shared bill pass totalBill plus people and/or myShare (and paidBy if a friend paid) instead of amount; only the user's share counts as spending.",
    schema: z.object({
      transactions: z
        .array(txItemSchema)
        .min(1)
        .max(50)
        .describe("All transactions to add in this call (1-50). Include every row the user listed."),
    }),
  }
);

// ─── Tool: list_transactions ───────────────────────────────────────────────────

export const listTransactionsToolDef = tool(
  async (
    {
      startDate,
      endDate,
      type,
      categoryName,
      limit,
    }: {
      startDate?: string;
      endDate?: string;
      type?: TransactionType;
      categoryName?: string;
      limit?: number;
    },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";

    const db = dbFromConfig(config);
    let query = db
      .from("transactions")
      .select("id, date, type, amount, description, categories(id, name)")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(limit ?? 10);

    if (startDate) query = (query as any).gte("date", startDate);
    if (endDate) query = (query as any).lte("date", endDate);
    if (type) query = (query as any).eq("type", type);

    const { data, error } = await query;
    if (error) return `Error: ${error.message}`;

    let rows = (data ?? []) as any[];

    if (categoryName) {
      const lower = categoryName.toLowerCase();
      rows = rows.filter((t) => {
        const cat = Array.isArray(t.categories) ? t.categories[0] : t.categories;
        return cat?.name?.toLowerCase().includes(lower);
      });
    }

    const transactions = rows.map((t) => {
      const cat = Array.isArray(t.categories) ? t.categories[0] : t.categories;
      return {
        id: t.id,
        date: t.date,
        type: t.type,
        amount: Number(t.amount),
        category: cat?.name ?? "Unknown",
        // Omit empty notes entirely — null keys are pure token noise on the
        // lookup path where the model re-reads this result.
        ...(t.description ? { description: t.description as string } : {}),
      };
    });

    return JSON.stringify({ count: transactions.length, transactions });
  },
  {
    name: "list_transactions",
    description:
      "List transactions with optional filters. Always call this first to get transaction IDs before updating or deleting.",
    schema: z.object({
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      type: z.enum(["income", "expense"]).optional(),
      categoryName: z.string().optional().describe("Filter by category name"),
      limit: z.number().optional().default(10).describe("Max results, default 10"),
      purpose: purposeParam,
    }),
  }
);

// ─── Tool: update_transaction ──────────────────────────────────────────────────

export const editTransactionToolDef = tool(
  async (
    {
      action,
      id,
      amount,
      type,
      categoryName,
      date,
      description,
    }: {
      action: "update" | "delete";
      id: string;
      amount?: number;
      type?: TransactionType;
      categoryName?: string;
      date?: string;
      description?: string;
    },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";

    const db = dbFromConfig(config);

    if (action === "delete") {
      const { data: tx, error: fetchErr } = await db
        .from("transactions")
        .select("amount, type, date, categories(name)")
        .eq("id", id)
        .eq("user_id", userId)
        .single();

      if (fetchErr || !tx) return "Error: Transaction not found";

      const { error: deleteErr } = await db
        .from("transactions")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

      if (deleteErr) return `Error: ${deleteErr.message}`;

      const catName =
        tx.categories && !Array.isArray(tx.categories)
          ? (tx.categories as any).name
          : Array.isArray(tx.categories)
          ? (tx.categories[0] as any)?.name
          : "Unknown";

      return JSON.stringify({
        success: true,
        message: `Deleted ${tx.type} of ₹${tx.amount} (${catName}) on ${tx.date}`,
      });
    }

    const { data: old, error: fetchErr } = await db
      .from("transactions")
      .select("amount, type, date, category_id, description")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !old) return "Error: Transaction not found";

    const newType = (type ?? old.type) as TransactionType;
    const newAmount = amount !== undefined ? Number(amount) : Number(old.amount);
    const newDate = date ?? old.date;

    let newCategoryId = old.category_id;
    if (categoryName) {
      const cat = await resolveCategoryId(db, categoryName, newType);
      if (!cat) return `Category "${categoryName}" not found for ${newType}`;
      newCategoryId = cat.id;
    }

    const { error: updateErr } = await db
      .from("transactions")
      .update({
        amount: newAmount,
        type: newType,
        date: newDate,
        category_id: newCategoryId,
        // Only touch the note when the model explicitly provided one —
        // updating the amount must not wipe an existing description.
        description: description !== undefined ? description : old.description,
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (updateErr) {
      return `Error: ${updateErr.message}`;
    }

    return JSON.stringify({ success: true, message: "Transaction updated successfully" });
  },
  {
    name: "edit_transaction",
    description:
      "Update or permanently delete an existing transaction by its ID. Use list_transactions first to get the ID. For update, only provide the fields you want to change. Always confirm with the user (request_destructive_confirmation) before action 'delete'.",
    schema: z.object({
      action: z.enum(["update", "delete"]),
      id: z.string().describe("Transaction ID from list_transactions"),
      amount: z.number().min(1).optional(),
      type: z.enum(["income", "expense"]).optional(),
      categoryName: z.string().optional(),
      date: z.string().optional().describe("New date YYYY-MM-DD"),
      description: z.string().optional(),
    }),
  }
);

// ─── Tool: get_report (spending summary + history merged, Phase D) ──────────────

export const getReportToolDef = tool(
  async (
    {
      scope,
      startDate,
      endDate,
      year,
      month,
    }: {
      scope: "range" | "month" | "year";
      startDate?: string;
      endDate?: string;
      year?: number;
      month?: number;
      purpose?: "display" | "lookup";
    },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";

    if (scope !== "range") return getHistoryReport(dbFromConfig(config), userId, scope, year, month);
    if (!startDate || !endDate)
      return "Error: startDate and endDate are required when scope is 'range'";

    const db = dbFromConfig(config);
    const { data: transactions, error } = await db
      .from("transactions")
      .select("type, amount, categories(name)")
      .eq("user_id", userId)
      .gte("date", startDate)
      .lte("date", endDate);

    if (error) return `Error: ${error.message}`;

    const rows = transactions ?? [];
    const totalIncome = rows
      .filter((t) => t.type === "income")
      .reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = rows
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Number(t.amount), 0);

    const byCategory = (type: TransactionType) => {
      const total = type === "income" ? totalIncome : totalExpense;
      const map = new Map<string, number>();
      rows
        .filter((t) => t.type === type)
        .forEach((t) => {
          const cat = Array.isArray(t.categories) ? t.categories[0] : t.categories;
          const name = (cat as any)?.name ?? "Other";
          map.set(name, (map.get(name) ?? 0) + Number(t.amount));
        });
      return Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, amount]) => ({
          name,
          amount,
          percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
        }));
    };

    return JSON.stringify({
      scope: "range",
      period: `${startDate} to ${endDate}`,
      totalIncome,
      totalExpense,
      netBalance: totalIncome - totalExpense,
      savingsRate:
        totalIncome > 0
          ? Math.round((1 - totalExpense / totalIncome) * 100)
          : 0,
      topExpenseCategories: byCategory("expense"),
      topIncomeCategories: byCategory("income"),
    });
  },
  {
    name: "get_report",
    description:
      "Spending report. scope 'range' = income/expense totals + category breakdown between startDate and endDate; scope 'month' = daily breakdown for one month (needs year + month); scope 'year' = monthly breakdown (needs year).",
    schema: z.object({
      scope: z.enum(["range", "month", "year"]),
      startDate: z.string().optional().describe("Start date YYYY-MM-DD (scope 'range')"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD (scope 'range')"),
      year: z.number().optional().describe("Year, e.g. 2026 (scope 'month'/'year')"),
      month: z.number().min(1).max(12).optional().describe("Month 1-12 (scope 'month')"),
      purpose: purposeParam,
      chart: z
        .enum(["bar", "line", "area", "none"])
        .optional()
        .describe(
          "How the app should chart this for the user: 'bar' for discrete periods, 'line' for a trend, 'area' for a cumulative feel, 'none' to skip the chart. Omit to let the app decide."
        ),
    }),
  }
);

// History branch of get_report (daily/monthly rollups from the history tables).
async function getHistoryReport(
  db: DbClient,
  userId: string,
  scope: "month" | "year",
  year?: number,
  month?: number
): Promise<string> {
  if (!year) return "Error: year is required when scope is 'month' or 'year'";

  if (scope === "month") {
      if (!month) return "Error: month is required when scope is 'month'";
      const { data, error } = await db
        .from("month_history")
        .select("day, income, expense")
        .eq("user_id", userId)
        .eq("month", month)
        .eq("year", year)
        .order("day");
      if (error) return `Error: ${error.message}`;

      const days = (data ?? []).map((r) => ({
        day: r.day,
        income: Number(r.income),
        expense: Number(r.expense),
        net: Number(r.income) - Number(r.expense),
      }));
      const totalIncome = days.reduce((s, d) => s + d.income, 0);
      const totalExpense = days.reduce((s, d) => s + d.expense, 0);
      const peakExpense = [...days].sort((a, b) => b.expense - a.expense)[0] ?? null;
      const peakIncome = [...days].sort((a, b) => b.income - a.income)[0] ?? null;

      return JSON.stringify({
        scope,
        year,
        month,
        totalIncome,
        totalExpense,
        netBalance: totalIncome - totalExpense,
        peakExpenseDay: peakExpense,
        peakIncomeDay: peakIncome,
        days,
      });
    }

    const { data, error } = await db
      .from("year_history")
      .select("month, income, expense")
      .eq("user_id", userId)
      .eq("year", year)
      .order("month");
    if (error) return `Error: ${error.message}`;

    const months = (data ?? []).map((r) => ({
      month: r.month,
      income: Number(r.income),
      expense: Number(r.expense),
      net: Number(r.income) - Number(r.expense),
    }));
    const totalIncome = months.reduce((s, m) => s + m.income, 0);
    const totalExpense = months.reduce((s, m) => s + m.expense, 0);
    const bestMonth = [...months].sort((a, b) => b.net - a.net)[0] ?? null;
    const worstMonth = [...months].sort((a, b) => a.net - b.net)[0] ?? null;

    return JSON.stringify({
      scope,
      year,
      totalIncome,
      totalExpense,
      netBalance: totalIncome - totalExpense,
      bestMonth,
      worstMonth,
      months,
    });
}

// ─── Budget helpers ────────────────────────────────────────────────────────────

function currentMonthBounds() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${y}-${pad(m + 1)}-01`,
    end: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`,
    label: `${y}-${pad(m + 1)}`,
  };
}

// ─── Tool: budget (set + status merged, Phase D) ────────────────────────────────

export const budgetToolDef = tool(
  async (
    {
      action,
      categoryName,
      amount,
    }: {
      action: "set" | "status";
      categoryName?: string;
      amount?: number;
      purpose?: "display" | "lookup";
    },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";

    if (action === "status") return getBudgetStatusReport(dbFromConfig(config), userId);

    if (!amount || amount <= 0)
      return "Error: amount must be greater than 0 when action is 'set'";

    const db = dbFromConfig(config);

    let categoryId: string | null = null;
    let label = "overall";
    if (categoryName) {
      const cat = await resolveCategoryId(db, categoryName, "expense");
      if (!cat) {
        const { data: cats } = await db
          .from("categories")
          .select("name")
          .eq("type", "expense");
        return `Expense category "${categoryName}" not found. Available: ${cats?.map((c) => c.name).join(", ") ?? "none"}`;
      }
      categoryId = cat.id;
      label = cat.name;
    }

    let existingQuery = db.from("budgets").select("id").eq("user_id", userId);
    existingQuery = categoryId
      ? existingQuery.eq("category_id", categoryId)
      : existingQuery.is("category_id", null);
    const { data: existing } = await existingQuery.maybeSingle();

    if (existing) {
      const { error } = await db
        .from("budgets")
        .update({ amount, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) return `Error: ${error.message}`;
    } else {
      const { error } = await db
        .from("budgets")
        .insert({ user_id: userId, category_id: categoryId, amount });
      if (error) return `Error: ${error.message}`;
    }

    return JSON.stringify({
      success: true,
      message: `Set ${label} monthly budget to ₹${amount}`,
    });
  },
  {
    name: "budget",
    description:
      "Monthly budgets. action 'set' creates/updates a cap (amount required; omit categoryName for an overall budget). action 'status' reports each budget's amount, spent, remaining, and percentage used this month.",
    schema: z.object({
      action: z.enum(["set", "status"]),
      categoryName: z
        .string()
        .optional()
        .describe("Expense category name, or omit for an overall budget (action 'set')"),
      amount: z
        .number()
        .min(1)
        .optional()
        .describe("Monthly budget amount in rupees (₹), required for action 'set'"),
      purpose: purposeParam,
    }),
  }
);

// Status branch of the budget tool.
async function getBudgetStatusReport(db: DbClient, userId: string): Promise<string> {
  {
    const { start, end, label } = currentMonthBounds();

    const [{ data: budgets, error: bErr }, { data: txns, error: tErr }] =
      await Promise.all([
        db
          .from("budgets")
          .select("category_id, amount, categories(name)")
          .eq("user_id", userId),
        db
          .from("transactions")
          .select("amount, category_id")
          .eq("user_id", userId)
          .eq("type", "expense")
          .gte("date", start)
          .lte("date", end),
      ]);
    if (bErr || tErr) return `Error: ${(bErr ?? tErr)?.message}`;

    const spentBy = new Map<string, number>();
    let totalExpense = 0;
    for (const t of txns ?? []) {
      const a = Number(t.amount);
      totalExpense += a;
      if (t.category_id) spentBy.set(t.category_id, (spentBy.get(t.category_id) ?? 0) + a);
    }

    if (!budgets?.length) {
      return JSON.stringify({
        month: label,
        hasBudgets: false,
        totalExpense,
        message: "No budgets set yet.",
      });
    }

    let overall: Record<string, number> | null = null;
    const categories: Record<string, string | number>[] = [];
    for (const b of budgets) {
      const amount = Number(b.amount);
      if (!b.category_id) {
        overall = {
          amount,
          spent: totalExpense,
          remaining: amount - totalExpense,
          percentage: amount > 0 ? Math.round((totalExpense / amount) * 100) : 0,
        };
        continue;
      }
      const cat = Array.isArray(b.categories) ? b.categories[0] : b.categories;
      const spent = spentBy.get(b.category_id) ?? 0;
      categories.push({
        category: (cat as any)?.name ?? "Unknown",
        amount,
        spent,
        remaining: amount - spent,
        percentage: amount > 0 ? Math.round((spent / amount) * 100) : 0,
      });
    }
    categories.sort((a, b) => (b.percentage as number) - (a.percentage as number));

    return JSON.stringify({ month: label, hasBudgets: true, overall, categories });
  }
}

// ─── Tool: create_recurring_transaction ────────────────────────────────────────

export const createRecurringTransactionToolDef = tool(
  async (
    {
      amount,
      type,
      categoryName,
      dayOfMonth,
      description,
    }: {
      amount: number;
      type: TransactionType;
      categoryName: string;
      dayOfMonth: number;
      description?: string;
    },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";
    if (!amount || amount <= 0) return "Error: amount must be greater than 0";
    if (dayOfMonth < 1 || dayOfMonth > 28)
      return "Error: dayOfMonth must be between 1 and 28";

    const db = dbFromConfig(config);
    const category = await resolveCategoryId(db, categoryName, type);
    if (!category) {
      const { data: cats } = await db
        .from("categories")
        .select("name")
        .eq("type", type)
    .eq("hidden", false);
      return `Category "${categoryName}" not found for ${type}. Available: ${cats?.map((c) => c.name).join(", ") ?? "none"}`;
    }

    const lastRun = lastDueOnOrBefore(new Date(), dayOfMonth);

    const { error } = await db.from("recurring_rules").insert({
      user_id: userId,
      category_id: category.id,
      amount: Number(amount),
      type,
      description: description ?? null,
      day_of_month: dayOfMonth,
      last_run_date: lastRun,
    });
    if (error) return `Error: ${error.message}`;

    const next = nextDueAfter(lastRun, dayOfMonth);
    return JSON.stringify({
      success: true,
      message: `Scheduled ${type} of ₹${amount} in ${category.name} on the ${ordinal(dayOfMonth)} of each month. First auto-post: ${next}.`,
    });
  },
  {
    name: "create_recurring_transaction",
    description:
      "Schedule a transaction to auto-post once a month (rent, salary, subscriptions). It first posts on the next occurrence of the given day — it does not back-post the current month. dayOfMonth must be 1-28.",
    schema: z.object({
      amount: z.number().min(1).describe("Amount in rupees (₹)"),
      type: z.enum(["income", "expense"]),
      categoryName: z.string().describe("Category name, fuzzy-matched"),
      dayOfMonth: z.number().min(1).max(28).describe("Day of month to post on, 1-28"),
      description: z.string().optional(),
    }),
  }
);

// ─── Exported tool registry ────────────────────────────────────────────────────

// ─── Shared bills ──────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Some models occasionally emit malformed tool JSON where the bill fields end
 * up inside the description string, e.g. 'movie","totalBill":1200,"people":3'.
 * Pull those numbers back out and clean the note.
 */
function recoverLeakedFields(tx: z.infer<typeof txItemSchema>): z.infer<typeof txItemSchema> {
  const d = tx.description;
  if (!d || tx.amount != null || tx.totalBill != null || !/"(amount|totalBill)"\s*:/.test(d)) return tx;
  const num = (k: string) => {
    const m = new RegExp(`"${k}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`).exec(d);
    return m ? Number(m[1]) : undefined;
  };
  const str = (k: string) => {
    const m = new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(d);
    return m ? m[1] : undefined;
  };
  return {
    ...tx,
    amount: num("amount"),
    totalBill: num("totalBill"),
    people: num("people"),
    myShare: num("myShare"),
    paidBy: str("paidBy"),
    description: d.split(/"\s*,\s*"/)[0].replace(/["\\]+$/, "").trim() || undefined,
  };
}

/** Turns a tool row into DB columns: amount = the user's share. */
function splitFields(input: z.infer<typeof txItemSchema>):
  | { columns: Record<string, unknown> & { amount: number }; note: string }
  | { error: string } {
  const tx = recoverLeakedFields(input);
  const totalBill = tx.totalBill ?? tx.split?.totalBill;
  const people = tx.people ?? tx.split?.people;
  const myShare = tx.myShare ?? tx.split?.myShare;
  const paidBy = tx.paidBy ?? tx.split?.paidBy;
  if (totalBill == null) {
    if (tx.amount == null || tx.amount <= 0) return { error: "Missing amount. Send amount (a number field) — or for a shared bill send totalBill as its own number field plus people/myShare/paidBy. Never put numbers inside description." };
    return { columns: { amount: tx.amount }, note: "" };
  }
  if (myShare == null && !people) return { error: `For the ₹${totalBill} shared bill, say how many people or the user's share` };
  const share = myShare ?? round2(totalBill / (people as number));
  if (share > totalBill) return { error: `Share ₹${share} is more than the ₹${totalBill} bill` };
  const someoneElse = paidBy && !/^(me|i|myself|self|user)$/i.test(paidBy.trim()) ? paidBy.trim() : null;
  return {
    columns: {
      amount: share,
      split_total: totalBill,
      split_people: people ?? null,
      split_uneven: myShare != null,
      paid_amount: someoneElse ? 0 : totalBill,
      split_payer: someoneElse,
    },
    note: someoneElse
      ? ` (your share of ₹${totalBill}; ${someoneElse} paid)`
      : ` (your share; you paid ₹${totalBill}, ₹${round2(totalBill - share)} fronted for friends)`,
  };
}

// Dedicated tool for one shared bill. totalBill is REQUIRED here: models fill
// required number fields far more reliably than optional ones on a general tool.
export const logSharedBillToolDef = tool(
  async (
    input: { totalBill: number; people?: number; myShare?: number; paidBy?: string; categoryName: string; date: string; description?: string },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";
    const shared = splitFields({ ...input, type: "expense" });
    if ("error" in shared) return `Error: ${shared.error}`;
    const db = dbFromConfig(config);
    const category = await resolveCategoryId(db, input.categoryName, "expense");
    if (!category) return `Error: Category "${input.categoryName}" not found for expense`;

    // Same repeat-call guard as add_transactions, scoped to this chat turn.
    const turnStartedAt = (config as any)?.configurable?.turnStartedAt as string | undefined;
    if (turnStartedAt) {
      let q = db
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("category_id", category.id)
        .eq("date", input.date)
        .eq("amount", shared.columns.amount)
        .eq("split_total", input.totalBill)
        .gte("created_at", turnStartedAt);
      q = shared.columns.split_payer ? q.eq("split_payer", shared.columns.split_payer as string) : q.is("split_payer", null);
      const { count } = await q;
      if (count) return JSON.stringify({ success: true, message: "Already saved earlier in this turn — not added again." });
    }

    const { error } = await db.from("transactions").insert({
      user_id: userId,
      category_id: category.id,
      type: "expense",
      date: input.date,
      description: input.description ?? null,
      ...shared.columns,
    });
    if (error) return `Error: ${error.message}`;
    return JSON.stringify({
      success: true,
      message: `Added your share ₹${shared.columns.amount} in ${category.name} on ${input.date}${shared.note}${input.description ? ` — "${input.description}"` : ""}`,
    });
  },
  {
    name: "log_shared_bill",
    description:
      "Log ONE shared bill (split with friends). Only the user's share counts as spending; the tool computes it. Use for 'X dinner, my share Y', 'X movie, N of us', 'Priya paid X for ..., N of us'.",
    schema: z.object({
      totalBill: z.number().positive().describe("The whole bill in ₹ before splitting (required)"),
      people: z.number().int().min(2).max(20).optional().describe("How many people share it, including the user"),
      myShare: z.number().min(0).optional().describe("The user's share in ₹ if they stated it"),
      paidBy: z.string().optional().describe("Who paid: omit if the user paid, else the friend's name"),
      categoryName: z.string().describe("Expense category, e.g. Food and drinks, Entertainment"),
      date: z.string().describe("Date as YYYY-MM-DD"),
      description: z.string().optional().describe("Short note, plain text only"),
    }),
  }
);

export const settleUpToolDef = tool(
  async (
    { direction, counterparty, amount, date, description }: { direction: "in" | "out"; counterparty: string; amount: number; date: string; description?: string },
    config?: RunnableConfig
  ): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";
    const db = dbFromConfig(config);
    const { error } = await db.from("transactions").insert({
      user_id: userId,
      type: "transfer",
      transfer_direction: direction,
      counterparty,
      amount,
      date,
      description: description ?? null,
      category_id: null,
    });
    if (error) return `Error: ${error.message}`;
    return JSON.stringify({
      success: true,
      message: direction === "in"
        ? `Recorded ₹${amount} received from ${counterparty} on ${date} (a transfer, not income)`
        : `Recorded ₹${amount} paid back to ${counterparty} on ${date} (a transfer, not spending)`,
    });
  },
  {
    name: "settle_up",
    description:
      "Record money moving between the user and a friend: a friend paying the user back (direction 'in') or the user paying a friend back (direction 'out'). Saved as a transfer — never income or spending. Do not use add_transactions for these.",
    schema: z.object({
      direction: z.enum(["in", "out"]).describe("'in' = user got money back; 'out' = user paid someone back"),
      counterparty: z.string().min(1).describe("The friend's name"),
      amount: z.number().positive().describe("Amount in ₹"),
      date: z.string().describe("Date as YYYY-MM-DD"),
      description: z.string().optional(),
    }),
  }
);

export const getSharedSummaryToolDef = tool(
  async ({ month }: { month?: string }, config?: RunnableConfig): Promise<string> => {
    const userId = (config as any)?.configurable?.userId as string | undefined;
    if (!userId) return "Error: Not authenticated";
    const today = ((config as any)?.configurable?.today as string | undefined) ?? new Date().toISOString().slice(0, 10);
    const [y, m] = (month ?? today.slice(0, 7)).split("-").map(Number);
    if (!y || !m || m < 1 || m > 12) return "Error: month must be YYYY-MM";
    const summary = await getSharedSummary(dbFromConfig(config), userId, y, m);
    return JSON.stringify(summary);
  },
  {
    name: "get_shared_summary",
    description:
      "Money shared with friends in a month: fronted (paid for friends beyond the user's share), gotBack (friends paid the user back), friendsCovered (user's share of bills a friend paid), paidBack (user paid friends back), owedToYou and youOwe. Use for 'how much did I front', 'who owes me', 'what do I owe'.",
    schema: z.object({
      month: z.string().optional().describe("YYYY-MM; omit for the current month"),
    }),
  }
);

export const financeTools = [
  // get_categories intentionally omitted from the bound set — the full category
  // list is injected into the system prompt, and add/edit return the available
  // list on a bad name. Keeping it unbound saves a tool schema on every call.
  addTransactionsToolDef,
  listTransactionsToolDef,
  editTransactionToolDef,
  getReportToolDef,
  budgetToolDef,
  createRecurringTransactionToolDef,
  logSharedBillToolDef,
  settleUpToolDef,
  getSharedSummaryToolDef,
  ...hitlTools,
];

// Tools that mutate data — used by the frontend to trigger a dashboard refresh
export const MUTATING_TOOL_NAMES = new Set([
  "add_transactions",
  "edit_transaction",
  "budget",
  "settle_up",
  "log_shared_bill",
]);
  