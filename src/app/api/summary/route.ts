import { getAuthUser } from "@/utils/supabase/auth";
import { getRequestDb } from "@/utils/supabase/db";
import { getSummaryData } from "@/lib/server/dashboardData";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getAuthUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (!startDate || !endDate) {
    return new Response("startDate and endDate are required", { status: 400 });
  }

  try {
    const data = await getSummaryData(await getRequestDb(), user.id, startDate, endDate);
    return Response.json(data);
  } catch (error) {
    console.error("[GET /api/summary]", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
