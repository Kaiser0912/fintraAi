-- Baseline: prod (Fintra, zgvxcngfnbwmrebcazzh) public schema as of 2026-11-20.
-- Generated read-only from the catalog with `supabase db query --read-only`.
-- Already applied on prod: mark it applied there with
--   supabase migration repair --status applied 20251128000000
-- Note: RLS is NOT enabled on any table yet (fixed in FIN-8).

-- Tables

CREATE TABLE public.budgets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  category_id uuid,
  amount numeric NOT NULL,
  period text DEFAULT 'monthly'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.categories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  icon text NOT NULL,
  type text NOT NULL
);

CREATE TABLE public.month_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  day integer NOT NULL,
  month integer NOT NULL,
  year integer NOT NULL,
  income numeric(12,2) DEFAULT 0 NOT NULL,
  expense numeric(12,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.recurring_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  category_id uuid NOT NULL,
  amount numeric NOT NULL,
  type text NOT NULL,
  description text,
  day_of_month integer NOT NULL,
  active boolean DEFAULT true NOT NULL,
  last_run_date date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  category_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text,
  date date NOT NULL,
  type text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  currency text DEFAULT 'INR'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  model_provider text,
  model_name text,
  byo_key_cipher text,
  byo_key_last4 text,
  chat_quota_used integer DEFAULT 0 NOT NULL,
  chat_quota_month text
);

CREATE TABLE public.year_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  month integer NOT NULL,
  year integer NOT NULL,
  income numeric(12,2) DEFAULT 0 NOT NULL,
  expense numeric(12,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Constraints

ALTER TABLE public.budgets ADD CONSTRAINT budgets_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.budgets ADD CONSTRAINT budgets_period_check CHECK ((period = 'monthly'::text));
ALTER TABLE public.budgets ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);
ALTER TABLE public.categories ADD CONSTRAINT categories_name_type_key UNIQUE (name, type);
ALTER TABLE public.categories ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
ALTER TABLE public.categories ADD CONSTRAINT categories_type_check CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])));
ALTER TABLE public.month_history ADD CONSTRAINT month_history_day_check CHECK (((day >= 1) AND (day <= 31)));
ALTER TABLE public.month_history ADD CONSTRAINT month_history_month_check CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE public.month_history ADD CONSTRAINT month_history_pkey PRIMARY KEY (id);
ALTER TABLE public.month_history ADD CONSTRAINT month_history_user_id_day_month_year_key UNIQUE (user_id, day, month, year);
ALTER TABLE public.month_history ADD CONSTRAINT month_history_year_check CHECK ((year >= 2000));
ALTER TABLE public.recurring_rules ADD CONSTRAINT recurring_rules_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.recurring_rules ADD CONSTRAINT recurring_rules_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28)));
ALTER TABLE public.recurring_rules ADD CONSTRAINT recurring_rules_pkey PRIMARY KEY (id);
ALTER TABLE public.recurring_rules ADD CONSTRAINT recurring_rules_type_check CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])));
ALTER TABLE public.user_settings ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.user_settings ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);
ALTER TABLE public.year_history ADD CONSTRAINT year_history_month_check CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE public.year_history ADD CONSTRAINT year_history_pkey PRIMARY KEY (id);
ALTER TABLE public.year_history ADD CONSTRAINT year_history_user_id_month_year_key UNIQUE (user_id, month, year);
ALTER TABLE public.year_history ADD CONSTRAINT year_history_year_check CHECK ((year >= 2000));
ALTER TABLE public.budgets ADD CONSTRAINT budgets_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE public.recurring_rules ADD CONSTRAINT recurring_rules_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE public.transactions ADD CONSTRAINT fk_transaction_category FOREIGN KEY (category_id) REFERENCES categories(id);

-- Indexes

CREATE INDEX recurring_rules_active_idx ON public.recurring_rules USING btree (user_id, active);
CREATE UNIQUE INDEX budgets_user_category_uniq ON public.budgets USING btree (user_id, category_id) WHERE (category_id IS NOT NULL);
CREATE INDEX budgets_user_idx ON public.budgets USING btree (user_id);
CREATE UNIQUE INDEX budgets_user_overall_uniq ON public.budgets USING btree (user_id) WHERE (category_id IS NULL);
CREATE INDEX idx_month_history_user_year_month ON public.month_history USING btree (user_id, year, month);
CREATE INDEX idx_transactions_user_type_date ON public.transactions USING btree (user_id, type, date);
CREATE INDEX idx_transactions_user_date ON public.transactions USING btree (user_id, date);
CREATE INDEX idx_transactions_user_category ON public.transactions USING btree (user_id, category_id);
CREATE INDEX idx_year_history_user_year ON public.year_history USING btree (user_id, year);
CREATE INDEX recurring_rules_user_idx ON public.recurring_rules USING btree (user_id);

-- Functions

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

-- Triggers

CREATE TRIGGER trg_transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row level security

CREATE POLICY "Categories are readable by authenticated users" ON public.categories AS PERMISSIVE FOR SELECT TO authenticated USING (true);
