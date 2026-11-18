ALTER TYPE "public"."journal_source" ADD VALUE 'config_document';--> statement-breakpoint
CREATE TABLE "config_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"type_name" text NOT NULL,
	"number" text,
	"date" date,
	"posted" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL,
	"tables" jsonb NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cr_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "cr_kind_ck" CHECK ("config_records"."kind" in ('catalog', 'document'))
);
--> statement-breakpoint
CREATE TABLE "configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cfg_org_version_uq" UNIQUE("organization_id","version")
);
--> statement-breakpoint
CREATE TABLE "register_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"register" text NOT NULL,
	"recorder_id" uuid NOT NULL,
	"period" date NOT NULL,
	"dimensions" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_records" ADD CONSTRAINT "config_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_records" ADD CONSTRAINT "config_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_records" ADD CONSTRAINT "cr_je_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurations" ADD CONSTRAINT "configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurations" ADD CONSTRAINT "configurations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_movements" ADD CONSTRAINT "rm_recorder_fk" FOREIGN KEY ("organization_id","recorder_id") REFERENCES "public"."config_records"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cr_org_type_idx" ON "config_records" USING btree ("organization_id","type_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cr_org_type_number_uq" ON "config_records" USING btree ("organization_id","type_name","number") WHERE "config_records"."number" is not null;--> statement-breakpoint
CREATE INDEX "rm_org_register_idx" ON "register_movements" USING btree ("organization_id","register");--> statement-breakpoint
CREATE INDEX "rm_recorder_idx" ON "register_movements" USING btree ("organization_id","recorder_id");