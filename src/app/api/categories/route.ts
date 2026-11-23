import { getRequestDb } from "@/utils/supabase/db";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");

  if (type && type !== "income" && type !== "expense") {
    return new Response("Invalid category type", { status: 400 });
  }

  const supabase = await getRequestDb();
  let query = supabase.from("categories").select("id, name, icon").eq("hidden", false).order("name");
  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) {
    console.error("[GET /api/categories]", error);
    return new Response("Internal Server Error", { status: 500 });
  }

  return Response.json(data, { status: 200 });
}
