-- FIN-13 — month_history / year_history maintained by the database.
--
-- Rule: only rows with status 'paid' and type 'income' or 'expense' count.
-- Expenses count `amount` (your share), never paid_amount. Transfers and
-- pending/failed payments are skipped.
--
-- Before this, five places in the app (add, edit, delete, CSV import,
-- recurring, chat tools) each read a history row and wrote it back, which
-- could lose updates and drift from the transactions. Now one trigger on
-- transactions applies every change atomically, and the app no longer
-- writes history at all.
--
-- The backfill at the end recomputes both tables from transactions, so after
-- this migration every total equals a direct sum over transactions.

-- ─── Delta helper ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_history_delta(
  p_user_id text,
  p_date    date,
  p_income  numeric,
  p_expense numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_income = 0 AND p_expense = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.month_history AS h (user_id, day, month, year, income, expense)
  VALUES (p_user_id,
          EXTRACT(DAY FROM p_date)::int,
          EXTRACT(MONTH FROM p_date)::int,
          EXTRACT(YEAR FROM p_date)::int,
          p_income, p_expense)
  ON CONFLICT (user_id, day, month, year) DO UPDATE
    SET income  = h.income  + EXCLUDED.income,
        expense = h.expense + EXCLUDED.expense;

  INSERT INTO public.year_history AS h (user_id, month, year, income, expense)
  VALUES (p_user_id,
          EXTRACT(MONTH FROM p_date)::int,
          EXTRACT(YEAR FROM p_date)::int,
          p_income, p_expense)
  ON CONFLICT (user_id, month, year) DO UPDATE
    SET income  = h.income  + EXCLUDED.income,
        expense = h.expense + EXCLUDED.expense;
END;
$$;

-- Only the trigger calls this; nobody else may.
REVOKE EXECUTE ON FUNCTION public.apply_history_delta(text, date, numeric, numeric) FROM PUBLIC, anon, authenticated;

-- ─── Trigger ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transactions_sync_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- take the old row back out
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.status = 'paid' AND OLD.type IN ('income', 'expense') THEN
    PERFORM public.apply_history_delta(
      OLD.user_id, OLD.date,
      CASE WHEN OLD.type = 'income'  THEN -OLD.amount ELSE 0 END,
      CASE WHEN OLD.type = 'expense' THEN -OLD.amount ELSE 0 END);
  END IF;

  -- put the new row in
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.status = 'paid' AND NEW.type IN ('income', 'expense') THEN
    PERFORM public.apply_history_delta(
      NEW.user_id, NEW.date,
      CASE WHEN NEW.type = 'income'  THEN NEW.amount ELSE 0 END,
      CASE WHEN NEW.type = 'expense' THEN NEW.amount ELSE 0 END);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transactions_sync_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_transactions_sync_history ON public.transactions;
CREATE TRIGGER trg_transactions_sync_history
  AFTER INSERT OR DELETE OR UPDATE OF amount, type, status, date, user_id
  ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_sync_history();

-- ─── History is now read-only for users ──────────────────────────────────────
-- The trigger writes it (as the table owner); the app only reads.

REVOKE INSERT, UPDATE, DELETE ON public.month_history, public.year_history FROM authenticated;

-- ─── Backfill: recompute both tables from transactions ───────────────────────

DELETE FROM public.month_history;
DELETE FROM public.year_history;

INSERT INTO public.month_history (user_id, day, month, year, income, expense)
SELECT user_id,
       EXTRACT(DAY FROM date)::int,
       EXTRACT(MONTH FROM date)::int,
       EXTRACT(YEAR FROM date)::int,
       COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0),
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)
FROM public.transactions
WHERE status = 'paid' AND type IN ('income', 'expense')
GROUP BY 1, 2, 3, 4;

INSERT INTO public.year_history (user_id, month, year, income, expense)
SELECT user_id,
       EXTRACT(MONTH FROM date)::int,
       EXTRACT(YEAR FROM date)::int,
       COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0),
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)
FROM public.transactions
WHERE status = 'paid' AND type IN ('income', 'expense')
GROUP BY 1, 2, 3;
