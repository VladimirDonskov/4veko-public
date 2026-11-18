CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"journal_line_id" uuid,
	CONSTRAINT "bsl_org_account_reference_uq" UNIQUE("organization_id","account_id","external_id"),
	CONSTRAINT "bsl_journal_line_uq" UNIQUE("journal_line_id"),
	CONSTRAINT "bsl_reference_ck" CHECK (btrim("bank_statement_lines"."external_id") <> ''),
	CONSTRAINT "bsl_amount_ck" CHECK ("bank_statement_lines"."amount" <> 0 and "bank_statement_lines"."amount" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"opening_balance" numeric(24, 2) NOT NULL,
	"closing_balance" numeric(24, 2) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bs_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "bs_org_account_reference_uq" UNIQUE("organization_id","account_id","external_id"),
	CONSTRAINT "bs_org_account_end_uq" UNIQUE("organization_id","account_id","end_date"),
	CONSTRAINT "bs_reference_ck" CHECK (btrim("bank_statements"."external_id") <> ''),
	CONSTRAINT "bs_period_ck" CHECK ("bank_statements"."start_date" <= "bank_statements"."end_date"),
	CONSTRAINT "bs_balances_ck" CHECK ("bank_statements"."opening_balance" <> 'NaN'::numeric and "bank_statements"."closing_balance" <> 'NaN'::numeric),
	CONSTRAINT "bs_close_ck" CHECK (("bank_statements"."status" = 'open' and "bank_statements"."closed_at" is null) or ("bank_statements"."status" = 'closed' and "bank_statements"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "jl_org_account_id_uq" UNIQUE("organization_id","account_id","id");
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bsl_statement_fk" FOREIGN KEY ("organization_id","account_id","statement_id") REFERENCES "public"."bank_statements"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bsl_journal_line_fk" FOREIGN KEY ("organization_id","account_id","journal_line_id") REFERENCES "public"."journal_lines"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bs_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bsl_org_statement_date_idx" ON "bank_statement_lines" USING btree ("organization_id","statement_id","date");
