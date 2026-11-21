import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/utils/supabase/server";

/**
 * Database access always runs as the signed-in user, so Row Level Security
 * decides what each query can see. There is no service-role client.
 */
export type Db = SupabaseClient;

/** The request's cookie-based client. Queries carry the user's session. */
export async function getRequestDb(): Promise<Db> {
  return createServerClient();
}

/**
 * A client bound to one access token, for work that outlives the request's
 * cookie scope (the chat stream and its agent tools).
 */
export function dbForToken(accessToken: string): Db {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}

/** Validated user plus their access token, or nulls when signed out. */
export async function getAuthSession() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, accessToken: null };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return { user, accessToken: session?.access_token ?? null };
}
