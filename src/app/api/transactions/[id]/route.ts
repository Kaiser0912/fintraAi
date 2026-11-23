import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const userId = user.id;

  const { id: transactionId } = await context.params;
  const db = await getRequestDb();

  const { data: tx, error: fetchError } = await db
    .from("transactions").select("id")
    .eq("id", transactionId).eq("user_id", userId).single();

  if (fetchError || !tx) return new Response("Transaction not found", { status: 404 });

  const { error: deleteError } = await db
    .from("transactions").delete().eq("id", transactionId).eq("user_id", userId);

  if (deleteError) {
    console.error("[DELETE /api/transactions/:id]", deleteError);
    return new Response(`DB Error: ${deleteError.message}`, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const userId = user.id;

  const { id: transactionId } = await context.params;

  let body: any;
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON body", { status: 400 }); }

  const { amount, date, description, categoryId, type } = body;
  const db = await getRequestDb();

  const { data: oldTx, error: fetchError } = await db
    .from("transactions").select("id")
    .eq("id", transactionId).eq("user_id", userId).single();

  if (fetchError || !oldTx) return new Response("Transaction not found", { status: 404 });

  const { error: updateError } = await db
    .from("transactions")
    .update({ amount: Number(amount), date, description: description ?? null, category_id: categoryId, type })
    .eq("id", transactionId).eq("user_id", userId);

  if (updateError) {
    console.error("[PUT /api/transactions/:id]", updateError);
    return new Response(`DB Error: ${updateError.message}`, { status: 500 });
  }

  return new Response("Transaction updated", { status: 200 });
}
