-- Phase 5 — Pay, split and log (FIN-1)
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- Ledger rules:
--   amount       = your share. Budgets, charts and history use only this.
--   paid_amount  = cash that left your account. NULL means "same as amount".
--   fronted      = paid_amount - amount (what you covered for friends).
--
-- Existing rows keep reading the same: every new column is nullable or has a
-- default that matches today's behaviour (status 'paid', source 'manual').
-- payee_id gets its foreign key in FIN-3 when the payees table is created.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS paid_amount   numeric,
  ADD COLUMN IF NOT EXISTS split_total   numeric,
  ADD COLUMN IF NOT EXISTS split_people  integer,
  ADD COLUMN IF NOT EXISTS split_payer   text,
  ADD COLUMN IF NOT EXISTS split_uneven  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status        text    NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS source        text    NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS needs_purpose boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payee_id      uuid;

-- Checks are dropped and re-added so the script stays re-runnable.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_paid_amount_check,
  DROP CONSTRAINT IF EXISTS transactions_split_total_check,
  DROP CONSTRAINT IF EXISTS transactions_share_within_split_check,
  DROP CONSTRAINT IF EXISTS transactions_split_people_check,
  DROP CONSTRAINT IF EXISTS transactions_status_check,
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_paid_amount_check
    CHECK (paid_amount IS NULL OR paid_amount >= 0),
  ADD CONSTRAINT transactions_split_total_check
    CHECK (split_total IS NULL OR split_total > 0),
  ADD CONSTRAINT transactions_share_within_split_check
    CHECK (split_total IS NULL OR amount <= split_total),
  ADD CONSTRAINT transactions_split_people_check
    CHECK (split_people IS NULL OR split_people BETWEEN 2 AND 20),
  ADD CONSTRAINT transactions_status_check
    CHECK (status IN ('pending', 'paid', 'failed')),
  ADD CONSTRAINT transactions_source_check
    CHECK (source IN ('manual', 'upi', 'sms', 'chat', 'recurring'));

-- Home inbox ("needs purpose") and pending-payment lookups.
CREATE INDEX IF NOT EXISTS transactions_needs_purpose_idx
  ON public.transactions (user_id)
  WHERE needs_purpose;

CREATE INDEX IF NOT EXISTS transactions_pending_idx
  ON public.transactions (user_id)
  WHERE status = 'pending';
