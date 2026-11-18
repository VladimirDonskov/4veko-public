import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Money is numeric(18,2), quantities numeric(18,4). Drizzle returns both as
// strings; all arithmetic goes through src/lib/money.ts (decimal.js).
const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });
const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("organization_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum("member_role", ["owner", "admin", "accountant", "sales", "viewer"]);
export const accountTypeEnum = pgEnum("account_type", ["asset", "liability", "equity", "revenue", "expense"]);
export const partyKindEnum = pgEnum("party_kind", ["customer", "vendor"]);
export const itemTypeEnum = pgEnum("item_type", ["inventory", "non_inventory", "service"]);
export const journalSourceEnum = pgEnum("journal_source", [
  "manual",
  "invoice",
  "invoice_void",
  "payment",
  "inventory_adjustment",
  "reversal",
  "purchase_receipt",
  "bill",
  "bill_void",
  "bill_payment",
  "config_document",
  "deposit",
  "deposit_void",
]);
export const salesOrderStatusEnum = pgEnum("sales_order_status", ["draft", "confirmed", "invoiced", "cancelled"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["open", "partially_paid", "paid", "void"]);
export const paymentMethodEnum = pgEnum("payment_method", ["check", "ach", "wire", "card", "cash", "other"]);
export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "draft",
  "issued",
  "partially_received",
  "received",
  "closed",
  "cancelled",
]);
export const billStatusEnum = pgEnum("bill_status", ["open", "partially_paid", "paid", "void"]);

// ---------------------------------------------------------------- platform

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    baseCurrency: text("base_currency").notNull().default("USD"),
    fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(1),
    booksClosedThrough: date("books_closed_through"),
    defaultTaxRate: numeric("default_tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    phone: text("phone"),
    email: text("email"),
    address: jsonb("address").$type<Address | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("org_fy_month_ck", sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check("org_tax_rate_ck", sql`${t.defaultTaxRate} >= 0 and ${t.defaultTaxRate} < 100`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("memberships_org_user_uq").on(t.organizationId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const numberSequences = pgTable(
  "number_sequences",
  {
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    nextValue: integer("next_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_created_idx").on(t.organizationId, t.createdAt)],
);

// ------------------------------------------------------------- master data

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    subtype: text("subtype").notNull(),
    description: text("description"),
    parentId: uuid("parent_id"),
    systemKey: text("system_key"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("accounts_org_id_uq").on(t.organizationId, t.id),
    unique("accounts_org_number_uq").on(t.organizationId, t.number),
    uniqueIndex("accounts_org_system_key_uq")
      .on(t.organizationId, t.systemKey)
      .where(sql`${t.systemKey} is not null`),
    foreignKey({
      name: "accounts_parent_fk",
      columns: [t.organizationId, t.parentId],
      foreignColumns: [t.organizationId, t.id],
    }),
  ],
);

export const parties = pgTable(
  "parties",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: partyKindEnum("kind").notNull(),
    displayName: text("display_name").notNull(),
    companyName: text("company_name"),
    email: text("email"),
    phone: text("phone"),
    billingAddress: jsonb("billing_address").$type<Address | null>(),
    termsDays: integer("terms_days").notNull().default(30),
    taxExempt: boolean("tax_exempt").notNull().default(false),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("parties_org_id_uq").on(t.organizationId, t.id),
    uniqueIndex("parties_org_kind_name_uq").on(t.organizationId, t.kind, sql`lower(${t.displayName})`),
    check("parties_terms_ck", sql`${t.termsDays} between 0 and 365`),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("locations_org_id_uq").on(t.organizationId, t.id),
    unique("locations_org_code_uq").on(t.organizationId, t.code),
    uniqueIndex("locations_org_default_uq")
      .on(t.organizationId)
      .where(sql`${t.isDefault}`),
  ],
);

export const items = pgTable(
  "items",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: itemTypeEnum("type").notNull(),
    unit: text("unit").notNull().default("ea"),
    salesPrice: money("sales_price").notNull().default("0"),
    purchaseCost: money("purchase_cost").notNull().default("0"),
    taxable: boolean("taxable").notNull().default(true),
    incomeAccountId: uuid("income_account_id").notNull(),
    cogsAccountId: uuid("cogs_account_id"),
    inventoryAccountId: uuid("inventory_account_id"),
    reorderPoint: qty("reorder_point"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("items_org_id_uq").on(t.organizationId, t.id),
    uniqueIndex("items_org_sku_uq").on(t.organizationId, sql`lower(${t.sku})`),
    check("items_price_ck", sql`${t.salesPrice} >= 0 and ${t.purchaseCost} >= 0`),
    check(
      "items_inventory_accounts_ck",
      sql`${t.type} <> 'inventory' or (${t.cogsAccountId} is not null and ${t.inventoryAccountId} is not null)`,
    ),
    foreignKey({
      name: "items_income_account_fk",
      columns: [t.organizationId, t.incomeAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "items_cogs_account_fk",
      columns: [t.organizationId, t.cogsAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "items_inventory_account_fk",
      columns: [t.organizationId, t.inventoryAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
  ],
);

// ------------------------------------------------------------------ ledger

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    date: date("date").notNull(),
    memo: text("memo"),
    sourceType: journalSourceEnum("source_type").notNull(),
    sourceId: uuid("source_id"),
    sourceNumber: text("source_number"),
    reversalOfId: uuid("reversal_of_id"),
    reversedById: uuid("reversed_by_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("je_org_id_uq").on(t.organizationId, t.id),
    unique("je_org_number_uq").on(t.organizationId, t.number),
    index("je_org_date_idx").on(t.organizationId, t.date),
    index("je_source_idx").on(t.organizationId, t.sourceType, t.sourceId),
    foreignKey({
      name: "je_reversal_of_fk",
      columns: [t.organizationId, t.reversalOfId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      name: "je_reversed_by_fk",
      columns: [t.organizationId, t.reversedById],
      foreignColumns: [t.organizationId, t.id],
    }),
  ],
);

// Inserted by a deferred trigger when an entry's posting transaction commits.
export const journalEntrySeals = pgTable(
  "journal_entry_seals",
  {
    organizationId: orgId(),
    journalEntryId: uuid("journal_entry_id").primaryKey(),
  },
  (t) => [
    foreignKey({
      name: "seal_entry_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    organizationId: orgId(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    description: text("description"),
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    partyId: uuid("party_id"),
  },
  (t) => [
    unique("jl_entry_line_uq").on(t.journalEntryId, t.lineNo),
    unique("jl_org_account_id_uq").on(t.organizationId, t.accountId, t.id),
    index("jl_org_account_idx").on(t.organizationId, t.accountId),
    index("jl_entry_idx").on(t.journalEntryId),
    check("jl_amounts_ck", sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} = 0) <> (${t.credit} = 0))`),
    foreignKey({
      name: "jl_entry_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
    // Deferred in SQL so the posting transaction can seal after collecting its lines.
    foreignKey({
      name: "jl_seal_fk",
      columns: [t.journalEntryId],
      foreignColumns: [journalEntrySeals.journalEntryId],
    }),
    foreignKey({
      name: "jl_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "jl_party_fk",
      columns: [t.organizationId, t.partyId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
  ],
);

// ------------------------------------------------------ bank reconciliation

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: id(),
    organizationId: orgId(),
    accountId: uuid("account_id").notNull(),
    externalId: text("external_id").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    // Accumulated balances can exceed the precision of an individual posting.
    openingBalance: numeric("opening_balance", { precision: 24, scale: 2 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 24, scale: 2 }).notNull(),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bs_org_account_id_uq").on(t.organizationId, t.accountId, t.id),
    unique("bs_org_account_reference_uq").on(t.organizationId, t.accountId, t.externalId),
    unique("bs_org_account_end_uq").on(t.organizationId, t.accountId, t.endDate),
    check("bs_reference_ck", sql`btrim(${t.externalId}) <> ''`),
    check("bs_period_ck", sql`${t.startDate} <= ${t.endDate}`),
    check("bs_balances_ck", sql`${t.openingBalance} <> 'NaN'::numeric and ${t.closingBalance} <> 'NaN'::numeric`),
    check(
      "bs_close_ck",
      sql`(${t.status} = 'open' and ${t.closedAt} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null)`,
    ),
    foreignKey({
      name: "bs_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
  ],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: id(),
    organizationId: orgId(),
    accountId: uuid("account_id").notNull(),
    statementId: uuid("statement_id").notNull(),
    externalId: text("external_id").notNull(),
    date: date("date").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    journalLineId: uuid("journal_line_id"),
  },
  (t) => [
    unique("bsl_org_account_reference_uq").on(t.organizationId, t.accountId, t.externalId),
    unique("bsl_journal_line_uq").on(t.journalLineId),
    index("bsl_org_statement_date_idx").on(t.organizationId, t.statementId, t.date),
    check("bsl_reference_ck", sql`btrim(${t.externalId}) <> ''`),
    check("bsl_amount_ck", sql`${t.amount} <> 0 and ${t.amount} <> 'NaN'::numeric`),
    foreignKey({
      name: "bsl_statement_fk",
      columns: [t.organizationId, t.accountId, t.statementId],
      foreignColumns: [bankStatements.organizationId, bankStatements.accountId, bankStatements.id],
    }),
    foreignKey({
      name: "bsl_journal_line_fk",
      columns: [t.organizationId, t.accountId, t.journalLineId],
      foreignColumns: [journalLines.organizationId, journalLines.accountId, journalLines.id],
    }),
  ],
);

// ------------------------------------------------------------------- sales

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    customerId: uuid("customer_id").notNull(),
    orderDate: date("order_date").notNull(),
    expectedDate: date("expected_date"),
    status: salesOrderStatusEnum("status").notNull().default("draft"),
    memo: text("memo"),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("so_org_id_uq").on(t.organizationId, t.id),
    unique("so_org_number_uq").on(t.organizationId, t.number),
    index("so_org_customer_idx").on(t.organizationId, t.customerId),
    foreignKey({
      name: "so_customer_fk",
      columns: [t.organizationId, t.customerId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: id(),
    organizationId: orgId(),
    salesOrderId: uuid("sales_order_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    quantity: qty("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    amount: money("amount").notNull(),
    taxable: boolean("taxable").notNull(),
  },
  (t) => [
    unique("sol_order_line_uq").on(t.salesOrderId, t.lineNo),
    check("sol_qty_ck", sql`${t.quantity} > 0 and ${t.unitPrice} >= 0 and ${t.discountPct} between 0 and 100`),
    foreignKey({
      name: "sol_order_fk",
      columns: [t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sol_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    customerId: uuid("customer_id").notNull(),
    salesOrderId: uuid("sales_order_id"),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: invoiceStatusEnum("status").notNull().default("open"),
    memo: text("memo"),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    subtotal: money("subtotal").notNull(),
    taxTotal: money("tax_total").notNull(),
    total: money("total").notNull(),
    amountPaid: money("amount_paid").notNull().default("0"),
    balanceDue: money("balance_due").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    voidJournalEntryId: uuid("void_journal_entry_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("inv_org_id_uq").on(t.organizationId, t.id),
    unique("inv_org_number_uq").on(t.organizationId, t.number),
    uniqueIndex("inv_sales_order_active_uq")
      .on(t.organizationId, t.salesOrderId)
      .where(sql`${t.salesOrderId} is not null and ${t.status} <> 'void'`),
    index("inv_org_customer_idx").on(t.organizationId, t.customerId),
    index("inv_org_status_due_idx").on(t.organizationId, t.status, t.dueDate),
    check("inv_due_ck", sql`${t.dueDate} >= ${t.issueDate}`),
    check(
      "inv_amounts_ck",
      sql`${t.total} >= 0 and ${t.amountPaid} >= 0 and ${t.amountPaid} <= ${t.total} and ${t.balanceDue} = ${t.total} - ${t.amountPaid}`,
    ),
    foreignKey({
      name: "inv_customer_fk",
      columns: [t.organizationId, t.customerId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
    foreignKey({
      name: "inv_sales_order_fk",
      columns: [t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: "inv_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
    foreignKey({
      name: "inv_void_je_fk",
      columns: [t.organizationId, t.voidJournalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    organizationId: orgId(),
    invoiceId: uuid("invoice_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    quantity: qty("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    amount: money("amount").notNull(),
    taxable: boolean("taxable").notNull(),
    incomeAccountId: uuid("income_account_id").notNull(),
    costAmount: money("cost_amount"),
  },
  (t) => [
    unique("il_invoice_line_uq").on(t.invoiceId, t.lineNo),
    check("il_qty_ck", sql`${t.quantity} > 0 and ${t.unitPrice} >= 0`),
    foreignKey({
      name: "il_invoice_fk",
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: "il_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
    foreignKey({
      name: "il_income_account_fk",
      columns: [t.organizationId, t.incomeAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    customerId: uuid("customer_id").notNull(),
    date: date("date").notNull(),
    amount: money("amount").notNull(),
    unappliedAmount: money("unapplied_amount").notNull(),
    method: paymentMethodEnum("method").notNull(),
    reference: text("reference"),
    depositAccountId: uuid("deposit_account_id").notNull(),
    memo: text("memo"),
    idempotencyKey: text("idempotency_key"),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pmt_org_id_uq").on(t.organizationId, t.id),
    unique("pmt_org_number_uq").on(t.organizationId, t.number),
    uniqueIndex("pmt_org_idem_uq")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("pmt_org_customer_idx").on(t.organizationId, t.customerId),
    check("pmt_amount_ck", sql`${t.amount} > 0 and ${t.unappliedAmount} >= 0 and ${t.unappliedAmount} <= ${t.amount}`),
    foreignKey({
      name: "pmt_customer_fk",
      columns: [t.organizationId, t.customerId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
    foreignKey({
      name: "pmt_deposit_account_fk",
      columns: [t.organizationId, t.depositAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "pmt_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: id(),
    organizationId: orgId(),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    amount: money("amount").notNull(),
  },
  (t) => [
    unique("pa_payment_invoice_uq").on(t.paymentId, t.invoiceId),
    index("pa_invoice_idx").on(t.invoiceId),
    check("pa_amount_ck", sql`${t.amount} > 0`),
    foreignKey({
      name: "pa_payment_fk",
      columns: [t.organizationId, t.paymentId],
      foreignColumns: [payments.organizationId, payments.id],
    }),
    foreignKey({
      name: "pa_invoice_fk",
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
  ],
);

// -------------------------------------------------------- grouped deposits

export const deposits = pgTable(
  "deposits",
  {
    id: id(),
    organizationId: orgId(),
    number: text("number").notNull(),
    date: date("date").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    amount: money("amount").notNull(),
    memo: text("memo"),
    idempotencyKey: text("idempotency_key"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    status: text("status").$type<"posted" | "void">().notNull().default("posted"),
    voidDate: date("void_date"),
    voidReason: text("void_reason"),
    voidJournalEntryId: uuid("void_journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dep_org_id_uq").on(t.organizationId, t.id),
    unique("dep_org_number_uq").on(t.organizationId, t.number),
    unique("dep_journal_uq").on(t.journalEntryId),
    unique("dep_void_journal_uq").on(t.voidJournalEntryId),
    uniqueIndex("dep_org_idem_uq").on(t.organizationId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    index("dep_org_date_idx").on(t.organizationId, t.date),
    check("dep_amount_ck", sql`${t.amount} > 0 and ${t.amount} <> 'NaN'::numeric`),
    check("dep_status_ck", sql`
      (${t.status} = 'posted' and ${t.voidDate} is null and ${t.voidJournalEntryId} is null and ${t.voidReason} is null)
      or (${t.status} = 'void' and ${t.voidDate} is not null and ${t.voidDate} >= ${t.date}
        and ${t.voidJournalEntryId} is not null and ${t.voidJournalEntryId} <> ${t.journalEntryId}
        and ${t.voidReason} is not null and btrim(${t.voidReason}) <> '')
    `),
    foreignKey({
      name: "dep_bank_fk",
      columns: [t.organizationId, t.bankAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "dep_journal_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
    foreignKey({
      name: "dep_void_journal_fk",
      columns: [t.organizationId, t.voidJournalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

// Keep original membership after a void. The active claim is exclusive across deposits.
export const depositPayments = pgTable(
  "deposit_payments",
  {
    organizationId: orgId(),
    depositId: uuid("deposit_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    releasedOn: date("released_on"),
  },
  (t) => [
    primaryKey({ columns: [t.depositId, t.paymentId] }),
    uniqueIndex("dp_active_payment_uq").on(t.paymentId).where(sql`${t.releasedOn} is null`),
    index("dp_org_payment_idx").on(t.organizationId, t.paymentId),
    foreignKey({
      name: "dp_deposit_fk",
      columns: [t.organizationId, t.depositId],
      foreignColumns: [deposits.organizationId, deposits.id],
    }),
    foreignKey({
      name: "dp_payment_fk",
      columns: [t.organizationId, t.paymentId],
      foreignColumns: [payments.organizationId, payments.id],
    }),
  ],
);

// --------------------------------------------------------------- inventory

export const stockLevels = pgTable(
  "stock_levels",
  {
    organizationId: orgId(),
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    qtyOnHand: qty("qty_on_hand").notNull().default("0"),
    valueOnHand: money("value_on_hand").notNull().default("0"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.itemId, t.locationId] }),
    check("stock_nonneg_ck", sql`${t.qtyOnHand} >= 0 and ${t.valueOnHand} >= 0`),
    check("stock_empty_value_ck", sql`${t.qtyOnHand} > 0 or ${t.valueOnHand} = 0`),
    foreignKey({
      name: "stock_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
    foreignKey({
      name: "stock_location_fk",
      columns: [t.organizationId, t.locationId],
      foreignColumns: [locations.organizationId, locations.id],
    }),
  ],
);

export const stockMoves = pgTable(
  "stock_moves",
  {
    id: id(),
    organizationId: orgId(),
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    date: date("date").notNull(),
    quantity: qty("quantity").notNull(),
    valueChange: money("value_change").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceNumber: text("source_number"),
    journalEntryId: uuid("journal_entry_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("moves_org_item_idx").on(t.organizationId, t.itemId, t.date),
    check("moves_qty_ck", sql`${t.quantity} <> 0`),
    foreignKey({
      name: "moves_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
    foreignKey({
      name: "moves_location_fk",
      columns: [t.organizationId, t.locationId],
      foreignColumns: [locations.organizationId, locations.id],
    }),
    foreignKey({
      name: "moves_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const inventoryAdjustments = pgTable(
  "inventory_adjustments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    date: date("date").notNull(),
    locationId: uuid("location_id").notNull(),
    offsetAccountId: uuid("offset_account_id").notNull(),
    reason: text("reason").notNull(),
    memo: text("memo"),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("adj_org_id_uq").on(t.organizationId, t.id),
    unique("adj_org_number_uq").on(t.organizationId, t.number),
    foreignKey({
      name: "adj_location_fk",
      columns: [t.organizationId, t.locationId],
      foreignColumns: [locations.organizationId, locations.id],
    }),
    foreignKey({
      name: "adj_offset_account_fk",
      columns: [t.organizationId, t.offsetAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "adj_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const inventoryAdjustmentLines = pgTable(
  "inventory_adjustment_lines",
  {
    id: id(),
    organizationId: orgId(),
    adjustmentId: uuid("adjustment_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    quantityChange: qty("quantity_change").notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
    valueChange: money("value_change").notNull(),
  },
  (t) => [
    unique("adjl_adj_line_uq").on(t.adjustmentId, t.lineNo),
    check("adjl_qty_ck", sql`${t.quantityChange} <> 0`),
    foreignKey({
      name: "adjl_adj_fk",
      columns: [t.organizationId, t.adjustmentId],
      foreignColumns: [inventoryAdjustments.organizationId, inventoryAdjustments.id],
    }),
    foreignKey({
      name: "adjl_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
  ],
);

// -------------------------------------------------------------- purchasing

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    vendorId: uuid("vendor_id").notNull(),
    orderDate: date("order_date").notNull(),
    expectedDate: date("expected_date"),
    status: purchaseOrderStatusEnum("status").notNull().default("draft"),
    memo: text("memo"),
    total: money("total").notNull().default("0"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("po_org_id_uq").on(t.organizationId, t.id),
    unique("po_org_number_uq").on(t.organizationId, t.number),
    index("po_org_vendor_idx").on(t.organizationId, t.vendorId),
    foreignKey({
      name: "po_vendor_fk",
      columns: [t.organizationId, t.vendorId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    organizationId: orgId(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    quantity: qty("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    amount: money("amount").notNull(),
    qtyReceived: qty("qty_received").notNull().default("0"),
    qtyBilled: qty("qty_billed").notNull().default("0"),
  },
  (t) => [
    unique("pol_org_id_uq").on(t.organizationId, t.id),
    unique("pol_order_line_uq").on(t.purchaseOrderId, t.lineNo),
    // Three-way match in the database: never receive more than ordered, never bill more than received.
    check(
      "pol_qty_ck",
      sql`${t.quantity} > 0 and ${t.unitCost} >= 0 and ${t.qtyReceived} >= 0 and ${t.qtyReceived} <= ${t.quantity} and ${t.qtyBilled} >= 0 and ${t.qtyBilled} <= ${t.qtyReceived}`,
    ),
    foreignKey({
      name: "pol_order_fk",
      columns: [t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "pol_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
  ],
);

export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    date: date("date").notNull(),
    locationId: uuid("location_id").notNull(),
    memo: text("memo"),
    total: money("total").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rcv_org_id_uq").on(t.organizationId, t.id),
    unique("rcv_org_number_uq").on(t.organizationId, t.number),
    index("rcv_po_idx").on(t.organizationId, t.purchaseOrderId),
    foreignKey({
      name: "rcv_po_fk",
      columns: [t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
    }),
    foreignKey({
      name: "rcv_location_fk",
      columns: [t.organizationId, t.locationId],
      foreignColumns: [locations.organizationId, locations.id],
    }),
    foreignKey({
      name: "rcv_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: id(),
    organizationId: orgId(),
    receiptId: uuid("receipt_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    quantity: qty("quantity").notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    amount: money("amount").notNull(),
  },
  (t) => [
    unique("rcvl_receipt_line_uq").on(t.receiptId, t.lineNo),
    check("rcvl_qty_ck", sql`${t.quantity} > 0`),
    foreignKey({
      name: "rcvl_receipt_fk",
      columns: [t.organizationId, t.receiptId],
      foreignColumns: [purchaseReceipts.organizationId, purchaseReceipts.id],
    }),
    foreignKey({
      name: "rcvl_pol_fk",
      columns: [t.organizationId, t.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.organizationId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "rcvl_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
  ],
);

export const bills = pgTable(
  "bills",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    vendorId: uuid("vendor_id").notNull(),
    vendorReference: text("vendor_reference").notNull(),
    purchaseOrderId: uuid("purchase_order_id"),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: billStatusEnum("status").notNull().default("open"),
    memo: text("memo"),
    total: money("total").notNull(),
    amountPaid: money("amount_paid").notNull().default("0"),
    balanceDue: money("balance_due").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    voidJournalEntryId: uuid("void_journal_entry_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bill_org_id_uq").on(t.organizationId, t.id),
    unique("bill_org_number_uq").on(t.organizationId, t.number),
    // The same vendor invoice cannot be entered, and so paid, twice.
    uniqueIndex("bill_vendor_ref_active_uq")
      .on(t.organizationId, t.vendorId, sql`lower(${t.vendorReference})`)
      .where(sql`${t.status} <> 'void'`),
    index("bill_org_vendor_idx").on(t.organizationId, t.vendorId),
    index("bill_org_status_due_idx").on(t.organizationId, t.status, t.dueDate),
    check("bill_due_ck", sql`${t.dueDate} >= ${t.billDate}`),
    check(
      "bill_amounts_ck",
      sql`${t.total} > 0 and ${t.amountPaid} >= 0 and ${t.amountPaid} <= ${t.total} and ${t.balanceDue} = ${t.total} - ${t.amountPaid}`,
    ),
    foreignKey({
      name: "bill_vendor_fk",
      columns: [t.organizationId, t.vendorId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
    foreignKey({
      name: "bill_po_fk",
      columns: [t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.organizationId, purchaseOrders.id],
    }),
    foreignKey({
      name: "bill_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
    foreignKey({
      name: "bill_void_je_fk",
      columns: [t.organizationId, t.voidJournalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const billLines = pgTable(
  "bill_lines",
  {
    id: id(),
    organizationId: orgId(),
    billId: uuid("bill_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    // Either a received purchase order line (item, quantity, cost) or an expense line (account, amount).
    purchaseOrderLineId: uuid("purchase_order_line_id"),
    itemId: uuid("item_id"),
    quantity: qty("quantity"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
    accountId: uuid("account_id"),
    description: text("description"),
    amount: money("amount").notNull(),
  },
  (t) => [
    unique("bl_bill_line_uq").on(t.billId, t.lineNo),
    check(
      "bl_kind_ck",
      sql`(${t.purchaseOrderLineId} is not null and ${t.itemId} is not null and ${t.quantity} > 0 and ${t.unitCost} >= 0 and ${t.accountId} is null)
        or (${t.purchaseOrderLineId} is null and ${t.accountId} is not null and ${t.amount} > 0)`,
    ),
    foreignKey({
      name: "bl_bill_fk",
      columns: [t.organizationId, t.billId],
      foreignColumns: [bills.organizationId, bills.id],
    }),
    foreignKey({
      name: "bl_pol_fk",
      columns: [t.organizationId, t.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.organizationId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "bl_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [items.organizationId, items.id],
    }),
    foreignKey({
      name: "bl_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
  ],
);

export const billPayments = pgTable(
  "bill_payments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    vendorId: uuid("vendor_id").notNull(),
    date: date("date").notNull(),
    amount: money("amount").notNull(),
    method: paymentMethodEnum("method").notNull(),
    reference: text("reference"),
    payFromAccountId: uuid("pay_from_account_id").notNull(),
    memo: text("memo"),
    idempotencyKey: text("idempotency_key"),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bp_org_id_uq").on(t.organizationId, t.id),
    unique("bp_org_number_uq").on(t.organizationId, t.number),
    uniqueIndex("bp_org_idem_uq")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("bp_org_vendor_idx").on(t.organizationId, t.vendorId),
    check("bp_amount_ck", sql`${t.amount} > 0`),
    foreignKey({
      name: "bp_vendor_fk",
      columns: [t.organizationId, t.vendorId],
      foreignColumns: [parties.organizationId, parties.id],
    }),
    foreignKey({
      name: "bp_account_fk",
      columns: [t.organizationId, t.payFromAccountId],
      foreignColumns: [accounts.organizationId, accounts.id],
    }),
    foreignKey({
      name: "bp_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

export const billPaymentApplications = pgTable(
  "bill_payment_applications",
  {
    id: id(),
    organizationId: orgId(),
    billPaymentId: uuid("bill_payment_id").notNull(),
    billId: uuid("bill_id").notNull(),
    amount: money("amount").notNull(),
  },
  (t) => [
    unique("bpa_payment_bill_uq").on(t.billPaymentId, t.billId),
    index("bpa_bill_idx").on(t.billId),
    check("bpa_amount_ck", sql`${t.amount} > 0`),
    foreignKey({
      name: "bpa_payment_fk",
      columns: [t.organizationId, t.billPaymentId],
      foreignColumns: [billPayments.organizationId, billPayments.id],
    }),
    foreignKey({
      name: "bpa_bill_fk",
      columns: [t.organizationId, t.billId],
      foreignColumns: [bills.organizationId, bills.id],
    }),
  ],
);

// ----------------------------------------------- configurations (Veko code)

export const configurations = pgTable(
  "configurations",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    comment: text("comment"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique("cfg_org_version_uq").on(t.organizationId, t.version)],
);

/** Catalog items and documents declared in an organization's configuration. */
export const configRecords = pgTable(
  "config_records",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    typeName: text("type_name").notNull(),
    number: text("number"),
    date: date("date"),
    posted: boolean("posted").notNull().default(false),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    tables: jsonb("tables").$type<Record<string, Record<string, unknown>[]>>().notNull(),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("cr_org_id_uq").on(t.organizationId, t.id),
    index("cr_org_type_idx").on(t.organizationId, t.typeName, t.createdAt),
    uniqueIndex("cr_org_type_number_uq")
      .on(t.organizationId, t.typeName, t.number)
      .where(sql`${t.number} is not null`),
    check("cr_kind_ck", sql`${t.kind} in ('catalog', 'document')`),
    foreignKey({
      name: "cr_je_fk",
      columns: [t.organizationId, t.journalEntryId],
      foreignColumns: [journalEntries.organizationId, journalEntries.id],
    }),
  ],
);

/** Register movements written by posted configuration documents. */
export const registerMovements = pgTable(
  "register_movements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    register: text("register").notNull(),
    recorderId: uuid("recorder_id").notNull(),
    period: date("period").notNull(),
    dimensions: jsonb("dimensions").$type<Record<string, string | null>>().notNull(),
    resources: jsonb("resources").$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("rm_org_register_idx").on(t.organizationId, t.register),
    index("rm_recorder_idx").on(t.organizationId, t.recorderId),
    foreignKey({
      name: "rm_recorder_fk",
      columns: [t.organizationId, t.recorderId],
      foreignColumns: [configRecords.organizationId, configRecords.id],
    }),
  ],
);

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};
