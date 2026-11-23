import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb, type Db } from "@/utils/supabase/db";
import {
  patchTransactionSchema,
  replaceTransactionSchema,
  toApiTransaction,
  toDbColumns,
  TX_SELECT,
  validationError,
} from "@/lib/transactionApi";
import { dbErrorResponse } from "@/lib/dbErrors";

type Ctx = { params: Promise<{ id: string }> };

async function findOwned(db: Db, id: string, userId: string) {
  const { data } = await db
    .from("transactions").select("id, type, category_id")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  return data;
}

async function categoryMatches(db: Db, categoryId: string, type: string) {
  const { data } = await db.from("categories").select("type").eq("id", categoryId).maybeSingle();
  if (!data) return "Category not found";
  if (data.type !== type) return "Category type mismatch";
  return null;
}

export async function DELETE(req: Request, context: Ctx) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await context.params;
  const db = await getRequestDb();

  if (!(await findOwned(db, id, user.id))) return new Response("Transaction not found", { status: 404 });

  const { error } = await db.from("transactions").delete().eq("id", id).eq("user_id", user.id);
  if (error) return dbErrorResponse("DELETE /api/transactions/:id", error);

  return new Response(null, { status: 204 });
}

// Full replace of the editable fields (the edit form uses this).
export async function PUT(req: Request, context: Ctx) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await context.params;

  let body: unknown;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const parsed = replaceTransactionSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  const db = await getRequestDb();
  const existing = await findOwned(db, id, user.id);
  if (!existing) return new Response("Transaction not found", { status: 404 });
  if (existing.type === "transfer") return new Response("Transfers are edited through Settle up", { status: 400 });

  const mismatch = await categoryMatches(db, parsed.data.categoryId, parsed.data.type);
  if (mismatch) return new Response(mismatch, { status: mismatch === "Category not found" ? 404 : 400 });

  const { error } = await db
    .from("transactions")
    .update({ ...toDbColumns(parsed.data), description: parsed.data.description ?? null })
    .eq("id", id).eq("user_id", user.id);

  if (error) return dbErrorResponse("PUT /api/transactions/:id", error);

  return new Response("Transaction updated", { status: 200 });
}

// Partial update; returns the updated transaction.
export async function PATCH(req: Request, context: Ctx) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await context.params;

  let body: unknown;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const parsed = patchTransactionSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;

  const db = await getRequestDb();
  const existing = await findOwned(db, id, user.id);
  if (!existing) return new Response("Transaction not found", { status: 404 });
  if (existing.type === "transfer" && (input.type || input.categoryId)) {
    return new Response("Transfers are edited through Settle up", { status: 400 });
  }

  if (input.type || input.categoryId) {
    const mismatch = await categoryMatches(
      db,
      input.categoryId ?? existing.category_id,
      input.type ?? existing.type
    );
    if (mismatch) return new Response(mismatch, { status: mismatch === "Category not found" ? 404 : 400 });
  }

  const { data, error } = await db
    .from("transactions")
    .update(toDbColumns(input))
    .eq("id", id).eq("user_id", user.id)
    .select(TX_SELECT).single();

  if (error) return dbErrorResponse("PATCH /api/transactions/:id", error);

  return Response.json(toApiTransaction(data));
}
