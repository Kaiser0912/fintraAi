import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import {
  createTransactionSchema,
  toApiTransaction,
  toDbColumns,
  TX_SELECT,
  validationError,
} from "@/lib/transactionApi";
import { dbErrorResponse } from "@/lib/dbErrors";
export const dynamic = "force-dynamic";

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const userId = user.id;

  let body: unknown;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;

  const db = await getRequestDb();

  const { data: category, error: catError } = await db
    .from("categories").select("type").eq("id", input.categoryId).single();

  if (catError || !category) return new Response("Category not found", { status: 404 });
  if (category.type !== input.type) return new Response("Category type mismatch", { status: 400 });

  const { data: transaction, error: txError } = await db
    .from("transactions")
    .insert({ user_id: userId, ...toDbColumns(input) })
    .select(TX_SELECT).single();

  if (txError) return dbErrorResponse("POST /api/transactions", txError);

  return Response.json(toApiTransaction(transaction), { status: 201 });
}

export async function GET(req: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const userId = user.id;

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const page = Number(searchParams.get("page") ?? 1);
  const limit = Number(searchParams.get("limit") ?? 10);
  const type = searchParams.get("type");
  const categoryId = searchParams.get("categoryId");
  const search = searchParams.get("search");
  const status = searchParams.get("status");
  const needsPurpose = searchParams.get("needsPurpose");
  const offset = (page - 1) * limit;

  const db = await getRequestDb();

  let query = db
    .from("transactions")
    .select(TX_SELECT, { count: "exact" })
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (startDate && endDate) query = query.gte("date", startDate).lte("date", endDate);
  if (type) query = query.eq("type", type);
  if (categoryId) query = query.eq("category_id", categoryId);
  if (status) query = query.eq("status", status);
  if (needsPurpose === "true") query = query.eq("needs_purpose", true);
  if (search) {
    // Escape LIKE wildcards so user input is matched literally
    const escaped = search.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike("description", `%${escaped}%`);
  }

  const { data, count, error } = await query;
  if (error) {
    console.error("[GET /api/transactions]", error);
    return new Response("Internal Server Error", { status: 500 });
  }

  const total = count ?? 0;
  return Response.json({
    data: (data ?? []).map(toApiTransaction),
    pagination: { page, limit, total, hasNext: offset + limit < total, hasPrev: page > 1 },
  });
}
