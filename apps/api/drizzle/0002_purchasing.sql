CREATE TYPE "public"."bill_status" AS ENUM('open', 'partially_paid', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'purchase_receipt';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'bill';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'bill_void';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'bill_payment';--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"purchase_order_line_id" uuid,
	"item_id" uuid,
	"quantity" numeric(18, 4),
	"unit_cost" numeric(18, 4),
	"account_id" uuid,
	"description" text,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "bl_bill_line_uq" UNIQUE("bill_id","line_no"),
	CONSTRAINT "bl_kind_ck" CHECK (("bill_lines"."purchase_order_line_id" is not null and "bill_lines"."item_id" is not null and "bill_lines"."quantity" > 0 and "bill_lines"."unit_cost" >= 0 and "bill_lines"."account_id" is null)
        or ("bill_lines"."purchase_order_line_id" is null and "bill_lines"."account_id" is not null and "bill_lines"."amount" > 0))
);
--> statement-breakpoint
CREATE TABLE "bill_payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "bpa_payment_bill_uq" UNIQUE("bill_payment_id","bill_id"),
	CONSTRAINT "bpa_amount_ck" CHECK ("bill_payment_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"pay_from_account_id" uuid NOT NULL,
	"memo" text,
	"idempotency_key" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bp_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "bp_org_number_uq" UNIQUE("organization_id","number"),
	CONSTRAINT "bp_amount_ck" CHECK ("bill_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_reference" text NOT NULL,
	"purchase_order_id" uuid,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" "bill_status" DEFAULT 'open' NOT NULL,
	"memo" text,
	"total" numeric(18, 2) NOT NULL,
	"amount_paid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(18, 2) NOT NULL,
	"journal_entry_id" uuid,
	"void_journal_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "bill_org_number_uq" UNIQUE("organization_id","number"),
	CONSTRAINT "bill_due_ck" CHECK ("bills"."due_date" >= "bills"."bill_date"),
	CONSTRAINT "bill_amounts_ck" CHECK ("bills"."total" > 0 and "bills"."amount_paid" >= 0 and "bills"."amount_paid" <= "bills"."total" and "bills"."balance_due" = "bills"."total" - "bills"."amount_paid")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"qty_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"qty_billed" numeric(18, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "pol_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "pol_order_line_uq" UNIQUE("purchase_order_id","line_no"),
	CONSTRAINT "pol_qty_ck" CHECK ("purchase_order_lines"."quantity" > 0 and "purchase_order_lines"."unit_cost" >= 0 and "purchase_order_lines"."qty_received" >= 0 and "purchase_order_lines"."qty_received" <= "purchase_order_lines"."quantity" and "purchase_order_lines"."qty_billed" >= 0 and "purchase_order_lines"."qty_billed" <= "purchase_order_lines"."qty_received")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"memo" text,
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "po_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "rcvl_receipt_line_uq" UNIQUE("receipt_id","line_no"),
	CONSTRAINT "rcvl_qty_ck" CHECK ("purchase_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"date" date NOT NULL,
	"location_id" uuid NOT NULL,
	"memo" text,
	"total" numeric(18, 2) NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rcv_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "rcv_org_number_uq" UNIQUE("organization_id","number")
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bl_bill_fk" FOREIGN KEY ("organization_id","bill_id") REFERENCES "public"."bills"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bl_pol_fk" FOREIGN KEY ("organization_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bl_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bl_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payment_applications" ADD CONSTRAINT "bpa_payment_fk" FOREIGN KEY ("organization_id","bill_payment_id") REFERENCES "public"."bill_payments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payment_applications" ADD CONSTRAINT "bpa_bill_fk" FOREIGN KEY ("organization_id","bill_id") REFERENCES "public"."bills"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bp_vendor_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bp_account_fk" FOREIGN KEY ("organization_id","pay_from_account_id") REFERENCES "public"."accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bp_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bill_vendor_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bill_po_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bill_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bill_void_je_fk" FOREIGN KEY ("organization_id","void_journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "pol_order_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "pol_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "po_vendor_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "rcvl_receipt_fk" FOREIGN KEY ("organization_id","receipt_id") REFERENCES "public"."purchase_receipts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "rcvl_pol_fk" FOREIGN KEY ("organization_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "rcvl_item_fk" FOREIGN KEY ("organization_id","item_id") REFERENCES "public"."items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "rcv_po_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "rcv_location_fk" FOREIGN KEY ("organization_id","location_id") REFERENCES "public"."locations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "rcv_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bpa_bill_idx" ON "bill_payment_applications" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bp_org_idem_uq" ON "bill_payments" USING btree ("organization_id","idempotency_key") WHERE "bill_payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "bp_org_vendor_idx" ON "bill_payments" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_vendor_ref_active_uq" ON "bills" USING btree ("organization_id","vendor_id",lower("vendor_reference")) WHERE "bills"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "bill_org_vendor_idx" ON "bills" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "bill_org_status_due_idx" ON "bills" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "po_org_vendor_idx" ON "purchase_orders" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "rcv_po_idx" ON "purchase_receipts" USING btree ("organization_id","purchase_order_id");