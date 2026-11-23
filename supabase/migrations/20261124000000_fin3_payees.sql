-- FIN-3 — Saved UPI payees.
--
-- One row per person or shop a user has paid through Fintra. The Pay screen
-- uses it to fill in the name, guess the category and suggest recent purposes.
--
--   upi_id             stored lower-case, unique per user
--   kind               'merchant' (shop QR) | 'personal' (a friend's UPI ID)
--   default_category_id  last category used for this payee (optional)
--   recent_purposes    newest first, at most 5
--   last_paid_at       when the user last paid this payee
--
-- remember_payee() is how a payment records its payee: it inserts or updates
-- the row and pushes the purpose onto recent_purposes in one statement.

CREATE TABLE IF NOT EXISTS public.payees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  name                text NOT NULL CHECK (btrim(name) <> ''),
  upi_id              text NOT NULL
                        CHECK (upi_id = lower(upi_id))
                        -- Postgres regex repetition counts max out at 255
                        CHECK (upi_id ~ '^[a-z0-9._-]{2,255}@[a-z0-9]{2,64}$'),
  kind                text NOT NULL DEFAULT 'personal' CHECK (kind IN ('merchant', 'personal')),
  default_category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  recent_purposes     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recent_purposes) <= 5),
  last_paid_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payees_user_upi_key UNIQUE (user_id, upi_id),
  -- lets transactions reference (user_id, id), so a row can only point at
  -- its own owner's payee
  CONSTRAINT payees_user_id_id_key UNIQUE (user_id, id)
);

CREATE INDEX IF NOT EXISTS payees_user_recent_idx
  ON public.payees (user_id, last_paid_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_payees_updated_at ON public.payees;
CREATE TRIGGER trg_payees_updated_at
  BEFORE UPDATE ON public.payees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── Row level security (same rule as every other user table) ───────────────

ALTER TABLE public.payees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payees FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payees TO authenticated;

DROP POLICY IF EXISTS payees_owner ON public.payees;
CREATE POLICY payees_owner ON public.payees
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())::text)
  WITH CHECK (user_id = (SELECT auth.uid())::text);

-- ─── transactions.payee_id → payees ─────────────────────────────────────────
-- Composite key: the payee must belong to the same user as the transaction.
-- Deleting a payee keeps the transaction and clears only payee_id.

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_payee_fkey;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_payee_fkey
    FOREIGN KEY (user_id, payee_id)
    REFERENCES public.payees (user_id, id)
    ON DELETE SET NULL (payee_id);

CREATE INDEX IF NOT EXISTS transactions_payee_idx
  ON public.transactions (payee_id)
  WHERE payee_id IS NOT NULL;

-- ─── remember_payee(): upsert on payment ────────────────────────────────────
-- Runs as the caller (SECURITY INVOKER), so RLS still applies.

CREATE OR REPLACE FUNCTION public.remember_payee(
  p_upi_id      text,
  p_name        text,
  p_kind        text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_purpose     text DEFAULT NULL
)
RETURNS public.payees
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  uid     text := (SELECT auth.uid())::text;
  purpose text := NULLIF(btrim(p_purpose), '');
  result  public.payees;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.payees AS p
    (user_id, name, upi_id, kind, default_category_id, recent_purposes, last_paid_at)
  VALUES (
    uid,
    btrim(p_name),
    lower(btrim(p_upi_id)),
    COALESCE(p_kind, 'personal'),
    p_category_id,
    CASE WHEN purpose IS NULL THEN '{}'::text[] ELSE ARRAY[purpose] END,
    now()
  )
  ON CONFLICT (user_id, upi_id) DO UPDATE SET
    name                = EXCLUDED.name,
    kind                = COALESCE(p_kind, p.kind),
    default_category_id = COALESCE(p_category_id, p.default_category_id),
    -- newest first, no duplicates, at most 5
    recent_purposes     = ARRAY(
      SELECT x.v
      FROM unnest(
        CASE WHEN purpose IS NULL THEN p.recent_purposes
             ELSE ARRAY[purpose] || p.recent_purposes END
      ) WITH ORDINALITY AS x(v, ord)
      GROUP BY x.v
      ORDER BY min(x.ord)
      LIMIT 5
    ),
    last_paid_at        = now()
  RETURNING * INTO result;

  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.remember_payee(text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remember_payee(text, text, text, uuid, text) TO authenticated;
