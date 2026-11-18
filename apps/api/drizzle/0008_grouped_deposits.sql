ALTER TYPE "public"."journal_source" ADD VALUE 'deposit';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'deposit_void';--> statement-breakpoint
CREATE TABLE "deposit_payments" (
	"organization_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"released_on" date,
	CONSTRAINT "deposit_payments_deposit_id_payment_id_pk" PRIMARY KEY("deposit_id","payment_id")
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"memo" text,
	"idempotency_key" text,
	"journal_entry_id" uuid NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	"void_journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dep_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "dep_org_number_uq" UNIQUE("organization_id","number"),
	CONSTRAINT "dep_journal_uq" UNIQUE("journal_entry_id"),
	CONSTRAINT "dep_void_journal_uq" UNIQUE("void_journal_entry_id"),
	CONSTRAINT "dep_amount_ck" CHECK ("deposits"."amount" > 0 and "deposits"."amount" <> 'NaN'::numeric),
	CONSTRAINT "dep_status_ck" CHECK (
      ("deposits"."status" = 'posted' and "deposits"."void_date" is null and "deposits"."void_journal_entry_id" is null and "deposits"."void_reason" is null)
      or ("deposits"."status" = 'void' and "deposits"."void_date" is not null and "deposits"."void_date" >= "deposits"."date"
        and "deposits"."void_journal_entry_id" is not null and "deposits"."void_journal_entry_id" <> "deposits"."journal_entry_id"
        and "deposits"."void_reason" is not null and btrim("deposits"."void_reason") <> '')
    )
);
--> statement-breakpoint
ALTER TABLE "deposit_payments" ADD CONSTRAINT "dp_deposit_fk" FOREIGN KEY ("organization_id","deposit_id") REFERENCES "public"."deposits"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_payments" ADD CONSTRAINT "dp_payment_fk" FOREIGN KEY ("organization_id","payment_id") REFERENCES "public"."payments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "dep_bank_fk" FOREIGN KEY ("organization_id","bank_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "dep_journal_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "dep_void_journal_fk" FOREIGN KEY ("organization_id","void_journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dp_active_payment_uq" ON "deposit_payments" USING btree ("payment_id") WHERE "deposit_payments"."released_on" is null;--> statement-breakpoint
CREATE INDEX "dp_org_payment_idx" ON "deposit_payments" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dep_org_idem_uq" ON "deposits" USING btree ("organization_id","idempotency_key") WHERE "deposits"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "dep_org_date_idx" ON "deposits" USING btree ("organization_id","date");