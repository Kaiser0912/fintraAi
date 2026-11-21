import { getRequestDb } from "@/utils/supabase/db";

export async function GET() {
  try {
    const db = await getRequestDb();
    const { error } = await db.from("categories").select("id").limit(1);
    if (error) throw error;
    return Response.json({ status: "ok" });
  } catch (err) {
    return Response.json({ status: "error", message: String(err) }, { status: 500 });
  }
}
