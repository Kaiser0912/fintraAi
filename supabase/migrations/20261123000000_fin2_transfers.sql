-- FIN-2 — Transfer type for settle-ups and lending.
--
-- A transfer is money moving between you and someone else: a friend paying
-- you back, you paying a friend back, or lending. It is never income or
-- spending, so it is left out of totals, budgets, charts and history.
--
--   type                = 'transfer'
--   transfer_direction  = 'in'  (money came to you)  | 'out' (money left you)
--   counterparty        = who it was with (free text, optional)
--   category_id         = optional for transfers, required for income/expense
--
-- Existing rows in the old "Lent" / "Loan Repaid" categories become transfers
-- (out / in), their amounts are taken back out of month/year history, and
-- those two categories are hidden from pickers.

-- ─── transactions: allow 'transfer' ──────────────────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS transfer_direction text,
  ADD COLUMN IF NOT EXISTS counterparty       text;

ALTER TABLE public.transactions ALTER COLUMN category_id DROP NOT NULL;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check,
  DROP CONSTRAINT IF EXISTS transactions_transfer_direction_check,
  DROP CONSTRAINT IF EXISTS transactions_category_required_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
    CHECK (type IN ('income', 'expense', 'transfer')),
  -- direction is set exactly when the row is a transfer. The IS NOT NULL
  -- matters: without it a NULL direction makes the check NULL, which passes.
  ADD CONSTRAINT transactions_transfer_direction_check
    CHECK (
      (type = 'transfer' AND transfer_direction IS NOT NULL AND transfer_direction IN ('in', 'out'))
      OR (type <> 'transfer' AND transfer_direction IS NULL)
    ),
  ADD CONSTRAINT transactions_category_required_check
    CHECK (type = 'transfer' OR category_id IS NOT NULL);

-- ─── categories: hide retired ones ───────────────────────────────────────────

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- ─── Convert Lent / Loan Repaid rows into transfers ──────────────────────────
-- Only rows still typed income/expense are touched, so re-running is a no-op.

CREATE TEMP TABLE fin2_converted ON COMMIT DROP AS
SELECT t.id, t.user_id, t.date, t.amount, t.type AS old_type
FROM public.transactions t
JOIN public.categories c ON c.id = t.category_id
WHERE c.name IN ('Lent', 'Loan Repaid')
  AND t.type IN ('income', 'expense');

UPDATE public.transactions t
   SET type = 'transfer',
       transfer_direction = CASE WHEN c.name = 'Lent' THEN 'out' ELSE 'in' END
  FROM public.categories c, fin2_converted x
 WHERE c.id = t.category_id AND t.id = x.id;

-- Take the converted amounts back out of the history rollups.
UPDATE public.month_history h
   SET income  = GREATEST(0, h.income  - s.income),
       expense = GREATEST(0, h.expense - s.expense)
  FROM (
    SELECT user_id,
           EXTRACT(DAY FROM date)::int   AS day,
           EXTRACT(MONTH FROM date)::int AS month,
           EXTRACT(YEAR FROM date)::int  AS year,
           SUM(CASE WHEN old_type = 'income'  THEN amount ELSE 0 END) AS income,
           SUM(CASE WHEN old_type = 'expense' THEN amount ELSE 0 END) AS expense
    FROM fin2_converted GROUP BY 1, 2, 3, 4
  ) s
 WHERE h.user_id = s.user_id AND h.day = s.day AND h.month = s.month AND h.year = s.year;

UPDATE public.year_history h
   SET income  = GREATEST(0, h.income  - s.income),
       expense = GREATEST(0, h.expense - s.expense)
  FROM (
    SELECT user_id,
           EXTRACT(MONTH FROM date)::int AS month,
           EXTRACT(YEAR FROM date)::int  AS year,
           SUM(CASE WHEN old_type = 'income'  THEN amount ELSE 0 END) AS income,
           SUM(CASE WHEN old_type = 'expense' THEN amount ELSE 0 END) AS expense
    FROM fin2_converted GROUP BY 1, 2, 3
  ) s
 WHERE h.user_id = s.user_id AND h.month = s.month AND h.year = s.year;

UPDATE public.categories SET hidden = true WHERE name IN ('Lent', 'Loan Repaid');
