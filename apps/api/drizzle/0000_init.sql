CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'partially_paid', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."item_type" AS ENUM('inventory', 'non_inventory', 'service');--> statement-breakpoint
CREATE TYPE "public"."journal_source" AS ENUM('manual', 'invoice', 'invoice_void', 'payment', 'inventory_adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('customer', 'vendor');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('check', 'ach', 'wire', 'card', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'accountant', 'sales', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."sales_order_status" AS ENUM('draft', 'confirmed', 'invoiced', 'cancelled');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"subtype" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"system_key" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "accounts_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"data" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_change" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4),
	"value_change" numeric(18, 2) NOT NULL,
	CONSTRAINT "adjl_adj_line_uq" UNIQUE("adjustment_id","line_no"),
	CONSTRAINT "adjl_qty_ck" CHECK ("inventory_adjustment_lines"."quantity_change" <> 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"location_id" uuid NOT NULL,
	"offset_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"memo" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adj_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "adj_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"taxable" boolean NOT NULL,
	"income_account_id" uuid NOT NULL,
	"cost_amount" numeric(18, 2),
	CONSTRAINT "il_invoice_line_uq" UNIQUE("invoice_id","line_no"),
	CONSTRAINT "il_qty_ck" CHECK ("invoice_lines"."quantity" > 0 and "invoice_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"sales_order_id" uuid,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"memo" text,
	"tax_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"tax_total" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"amount_paid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(18, 2) NOT NULL,
	"journal_entry_id" uuid,
	"void_journal_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "inv_org_number_uq" UNIQUE("organization_id","number"),
	CONSTRAINT "inv_due_ck" CHECK ("invoices"."due_date" >= "invoices"."issue_date"),
	CONSTRAINT "inv_amounts_ck" CHECK ("invoices"."total" >= 0 and "invoices"."amount_paid" >= 0 and "invoices"."amount_paid" <= "invoices"."total" and "invoices"."balance_due" = "invoices"."total" - "invoices"."amount_paid")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "item_type" NOT NULL,
	"unit" text DEFAULT 'ea' NOT NULL,
	"sales_price" numeric(18, 2) DEFAULT '0' NOT NULL,
	"purchase_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"income_account_id" uuid NOT NULL,
	"cogs_account_id" uuid,
	"inventory_account_id" uuid,
	"reorder_point" numeric(18, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "items_price_ck" CHECK ("items"."sales_price" >= 0 and "items"."purchase_cost" >= 0),
	CONSTRAINT "items_inventory_accounts_ck" CHECK ("items"."type" <> 'inventory' or ("items"."cogs_account_id" is not null and "items"."inventory_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"date" date NOT NULL,
	"memo" text,
	"source_type" "journal_source" NOT NULL,
	"source_id" uuid,
	"source_number" text,
	"reversal_of_id" uuid,
	"reversed_by_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "je_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "je_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text,
	"debit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"party_id" uuid,
	CONSTRAINT "jl_entry_line_uq" UNIQUE("journal_entry_id","line_no"),
	CONSTRAINT "jl_amounts_ck" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and (("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0)))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "locations_org_code_uq" UNIQUE("organization_id","code")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_user_uq" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"next_value" integer NOT NULL,
	CONSTRAINT "number_sequences_organization_id_key_pk" PRIMARY KEY("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"books_closed_through" date,
	"default_tax_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"phone" text,
	"email" text,
	"address" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_fy_month_ck" CHECK ("organizations"."fiscal_year_start_month" between 1 and 12),
	CONSTRAINT "org_tax_rate_ck" CHECK ("organizations"."default_tax_rate" >= 0 and "organizations"."default_tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "party_kind" NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"email" text,
	"phone" text,
	"billing_address" jsonb,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "parties_terms_ck" CHECK ("parties"."terms_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "pa_payment_invoice_uq" UNIQUE("payment_id","invoice_id"),
	CONSTRAINT "pa_amount_ck" CHECK ("payment_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"unapplied_amount" numeric(18, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"deposit_account_id" uuid NOT NULL,
	"memo" text,
	"idempotency_key" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pmt_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "pmt_org_number_uq" UNIQUE("organization_id","number"),
	CONSTRAINT "pmt_amount_ck" CHECK ("payments"."amount" > 0 and "payments"."unapplied_amount" >= 0 and "payments"."unapplied_amount" <= "payments"."amount")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"taxable" boolean NOT NULL,
	CONSTRAINT "sol_order_line_uq" UNIQUE("sales_order_id","line_no"),
	CONSTRAINT "sol_qty_ck" CHECK ("sales_order_lines"."quantity" > 0 and "sales_order_lines"."unit_price" >= 0 and "sales_order_lines"."discount_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"status" "sales_order_status" DEFAULT 'draft' NOT NULL,
	"memo" text,
	"tax_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"subtotal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "so_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "so_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"value_on_hand" numeric(18, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_organization_id_item_id_location_id_pk" PRIMARY KEY("organization_id","item_id","location_id"),
	CONSTRAINT "stock_nonneg_ck" CHECK ("stock_levels"."qty_on_hand" >= 0 and "stock_levels"."value_on_hand" >= 0),
	CONSTRAINT "stock_empty_value_ck" CHECK ("stock_levels"."qty_on_hand" > 0 or "stock_levels"."value_on_hand" = 0)
);
--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"value_change" numeric(18, 2) NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_number" text,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moves_qty_ck" CHECK ("stock_moves"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "adjl_adj_fk" FOREIGN KEY ("organization_id","adjustment_id") REFERENCES "public"."inventory_adjustments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "adjl_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "adj_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "adj_offset_account_fk" FOREIGN KEY ("organization_id","offset_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "adj_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "il_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "il_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "il_income_account_fk" FOREIGN KEY ("organization_id","income_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "inv_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "inv_sales_order_fk" FOREIGN KEY ("organization_id","sales_order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "inv_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "inv_void_je_fk" FOREIGN KEY ("organization_id","void_journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_income_account_fk" FOREIGN KEY ("organization_id","income_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cogs_account_fk" FOREIGN KEY ("organization_id","cogs_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_inventory_account_fk" FOREIGN KEY ("organization_id","inventory_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "je_reversal_of_fk" FOREIGN KEY ("organization_id","reversal_of_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "je_reversed_by_fk" FOREIGN KEY ("organization_id","reversed_by_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "jl_entry_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "jl_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "jl_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "pa_payment_fk" FOREIGN KEY ("organization_id","payment_id") REFERENCES "public"."payments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "pa_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "pmt_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "pmt_deposit_account_fk" FOREIGN KEY ("organization_id","deposit_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "pmt_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sol_order_fk" FOREIGN KEY ("organization_id","sales_order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sol_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "so_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "moves_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "moves_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "moves_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_system_key_uq" ON "accounts" USING btree ("organization_id","system_key") WHERE "accounts"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_sales_order_active_uq" ON "invoices" USING btree ("organization_id","sales_order_id") WHERE "invoices"."sales_order_id" is not null and "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "inv_org_customer_idx" ON "invoices" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "inv_org_status_due_idx" ON "invoices" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_sku_uq" ON "items" USING btree ("organization_id",lower("sku"));--> statement-breakpoint
CREATE INDEX "je_org_date_idx" ON "journal_entries" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "je_source_idx" ON "journal_entries" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "jl_org_account_idx" ON "journal_lines" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE INDEX "jl_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_org_default_uq" ON "locations" USING btree ("organization_id") WHERE "locations"."is_default";--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_org_kind_name_uq" ON "parties" USING btree ("organization_id","kind",lower("display_name"));--> statement-breakpoint
CREATE INDEX "pa_invoice_idx" ON "payment_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmt_org_idem_uq" ON "payments" USING btree ("organization_id","idempotency_key") WHERE "payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "pmt_org_customer_idx" ON "payments" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "so_org_customer_idx" ON "sales_orders" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "moves_org_item_idx" ON "stock_moves" USING btree ("organization_id","item_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));