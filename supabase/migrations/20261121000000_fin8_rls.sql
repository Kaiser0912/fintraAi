-- FIN-8 — Row level security on every table.
--
-- Before this, RLS was off and the public anon key could read, insert and
-- delete every user's rows through the REST API. After this:
--   * anon can only read the shared category list;
--   * a signed-in user can only see and change rows where user_id is their
--     own auth id;
--   * the chat quota can only move through consume_chat_quota(), so a user
--     cannot reset their own counter with a direct REST call.
--
-- The app's server code now queries as the signed-in user (no service role).
-- Old code that still uses the service role keeps working, because the
-- service role bypasses RLS, so this can be applied before the code deploys.

-- ─── Shared category list ────────────────────────────────────────────────────

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.categories FROM anon, authenticated;
GRANT SELECT ON public.categories TO anon, authenticated;

DROP POLICY IF EXISTS "Categories are readable by authenticated users" ON public.categories;
DROP POLICY IF EXISTS categories_read ON public.categories;
CREATE POLICY categories_read ON public.categories
  FOR SELECT TO anon, authenticated
  USING (true);

-- ─── Per-user tables: owner-only access ──────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions', 'budgets', 'recurring_rules',
    'month_history', 'year_history', 'user_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING (user_id = (SELECT auth.uid())::text) '
      'WITH CHECK (user_id = (SELECT auth.uid())::text)',
      t || '_owner', t
    );
  END LOOP;
END $$;

-- ─── user_settings: quota columns are server-controlled ──────────────────────
-- Users may write their own currency and model choice, but not the quota.

REVOKE INSERT, UPDATE ON public.user_settings FROM authenticated;
GRANT INSERT (user_id, currency, model_provider, model_name, byo_key_cipher, byo_key_last4, updated_at)
  ON public.user_settings TO authenticated;
-- user_id is included because upserts set it on conflict; the policy's
-- WITH CHECK still pins it to the caller's own id.
GRANT UPDATE (user_id, currency, model_provider, model_name, byo_key_cipher, byo_key_last4, updated_at)
  ON public.user_settings TO authenticated;

CREATE OR REPLACE FUNCTION public.consume_chat_quota()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  this_month text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM');
  used integer;
BEGIN
  UPDATE public.user_settings
     SET chat_quota_used  = CASE WHEN chat_quota_month = this_month
                                 THEN chat_quota_used + 1 ELSE 1 END,
         chat_quota_month = this_month
   WHERE user_id = (SELECT auth.uid())::text
  RETURNING chat_quota_used INTO used;
  RETURN used;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_chat_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_chat_quota() TO authenticated;

-- ─── Advisor fix: pin the trigger function's search_path ────────────────────
ALTER FUNCTION public.set_updated_at() SET search_path = '';
