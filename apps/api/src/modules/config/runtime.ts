import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../db/client";
import { accounts, configRecords, configurations, items, parties, registerMovements, stockMoves } from "../../db/schema";
import { VekoError, type CatalogDecl, type DocumentDecl, type FieldDecl, type Pos } from "../../lang/ast";
import { compile, DOCUMENT_SYSTEM_FIELDS, type Schema } from "../../lang/checker";
import { Interpreter, VDate, VRecord, VRef, isDec, type Host, type Value } from "../../lang/interpreter";
import { audit } from "../../lib/audit";
import type { OrgContext } from "../../lib/context";
import { today } from "../../lib/dates";
import { AppError, invalid, notFound } from "../../lib/errors";
import { cents, D, dec, type Dec } from "../../lib/money";
import { nextConfigDocumentNumber } from "../../lib/numbering";
import type { SystemKey } from "../accounts/chart-template";
import { defaultLocationId, issueStock, linkMovesToEntry, receiveStock, removeStockExact } from "../inventory/service";
import { postJournalEntry, reverseJournalEntry, type PostingLine } from "../ledger/posting";
import { dimensionKey, inputToStored, isKernelType, isRefType, recordFromStored, valueToStored } from "./values";

// ------------------------------------------------------------ configuration

type Active = { version: number; source: string; schema: Schema };
const cache = new Map<string, Active>();

/** The organization's active (latest) configuration, compiled once per version. */
export async function activeConfig(db: DbOrTx, organizationId: string): Promise<Active | null> {
  const [row] = await db
    .select({ version: configurations.version, source: configurations.source })
    .from(configurations)
    .where(eq(configurations.organizationId, organizationId))
    .orderBy(desc(configurations.version))
    .limit(1);
  if (!row) return null;
  const hit = cache.get(organizationId);
  if (hit && hit.version === row.version) return hit;
  const { schema, diagnostics } = compile(row.source);
  if (diagnostics.length) throw new AppError(500, "config_invalid", `Stored configuration v${row.version} no longer compiles: ${diagnostics[0]!.describe()}`);
  const active = { version: row.version, source: row.source, schema };
  cache.set(organizationId, active);
  return active;
}

export function forgetConfig(organizationId: string) {
  cache.delete(organizationId);
}

export function metadata(schema: Schema) {
  const fields = (fs: FieldDecl[]) => fs.map((f) => ({ name: f.name, type: f.type.name, required: f.required }));
  return {
    catalogs: [...schema.catalogs.values()].map((c) => ({ name: c.name, fields: fields(c.fields), hasWrite: c.handlers.some((h) => h.event === "write") })),
    documents: [...schema.documents.values()].map((d) => ({
      name: d.name,
      fields: fields(d.fields),
      tables: d.tables.map((t) => ({ name: t.name, columns: fields(t.columns) })),
      hasWrite: d.handlers.some((h) => h.event === "write"),
      hasPost: d.handlers.some((h) => h.event === "post"),
    })),
    registers: [...schema.registers.values()].map((r) => ({
      name: r.name,
      nonnegative: r.nonnegative,
      dimensions: fields(r.dimensions),
      resources: fields(r.resources),
    })),
    functions: [...schema.functions.values()].map((f) => ({ name: f.name, params: f.params })),
  };
}

export function resolveType(schema: Schema, typeName: string): { kind: "catalog"; decl: CatalogDecl } | { kind: "document"; decl: DocumentDecl } {
  const c = schema.catalogs.get(typeName);
  if (c) return { kind: "catalog", decl: c };
  const d = schema.documents.get(typeName);
  if (d) return { kind: "document", decl: d };
  throw notFound(`"${typeName}" in the configuration`);
}

/** Turn a Veko error into an API error with its position. */
export function fromVeko(err: unknown): unknown {
  if (!(err instanceof VekoError)) return err;
  const details = { line: err.pos?.line, col: err.pos?.col, kind: err.kind };
  if (err.kind === "fail") return new AppError(422, "rule_failed", err.message, details);
  return new AppError(422, "code_error", err.describe(), details);
}

// --------------------------------------------------------------------- host

const ACCOUNT_KEYS: Record<string, SystemKey> = {
  receivable: "accounts_receivable",
  payable: "accounts_payable",
  inventory: "inventory",
  cash: "cash_operating",
  undeposited: "undeposited_funds",
  sales: "sales_revenue",
  services: "service_revenue",
  cogs: "cogs",
  salesTax: "sales_tax_payable",
  openingBalance: "opening_balance_equity",
  retainedEarnings: "retained_earnings",
};

/** Accounts kept by kernel subledgers, and which documents keep them. */
const CONTROL_ACCOUNTS = new Map<string, string>([
  ["accounts_receivable", "invoices and customer payments"],
  ["accounts_payable", "bills and bill payments"],
  ["inventory", "stock movements (use stock.receive / stock.issue)"],
  ["received_not_billed", "purchase receipts and bills"],
]);

type PostingState = { recordId: string; number: string; date: string; ledger: PostingLine[]; touched: Map<string, Map<string, Record<string, string | null>>> };

/** The platform kernel as seen from Veko code: every effect is checked and tenant-scoped. */
export class KernelHost implements Host {
  readonly messages: string[] = [];
  private refs = new Map<string, VRecord>();

  constructor(
    private readonly tx: Tx,
    private readonly ctx: OrgContext,
    private readonly schema: Schema,
    private readonly posting: PostingState | null,
  ) {}

  private fail(message: string, pos: Pos): never {
    throw new VekoError(message, pos);
  }

  async loadRef(ref: VRef, pos: Pos): Promise<VRecord> {
    const key = `${ref.type}:${ref.id}`;
    const hit = this.refs.get(key);
    if (hit) return hit;
    const org = this.ctx.organizationId;
    let rec: VRecord | null = null;
    if (ref.type === "Customer" || ref.type === "Vendor") {
      const [p] = await this.tx
        .select()
        .from(parties)
        .where(and(eq(parties.organizationId, org), eq(parties.id, ref.id), eq(parties.kind, ref.type === "Customer" ? "customer" : "vendor")));
      if (p) {
        rec = new VRecord(
          new Map<string, Value>([
            ["id", p.id],
            ["name", p.displayName],
            ["companyName", p.companyName],
            ["email", p.email],
            ["phone", p.phone],
            ["termsDays", new D(p.termsDays)],
            ["taxExempt", p.taxExempt],
          ]),
          undefined,
          ref.type,
          true,
        );
      }
    } else if (ref.type === "Item") {
      const [i] = await this.tx.select().from(items).where(and(eq(items.organizationId, org), eq(items.id, ref.id)));
      if (i) {
        rec = new VRecord(
          new Map<string, Value>([
            ["id", i.id],
            ["sku", i.sku],
            ["name", i.name],
            ["type", i.type],
            ["unit", i.unit],
            ["salesPrice", new D(i.salesPrice)],
            ["purchaseCost", new D(i.purchaseCost)],
            ["taxable", i.taxable],
          ]),
          undefined,
          "Item",
          true,
        );
      }
    } else if (ref.type === "Account") {
      const [a] = await this.tx.select().from(accounts).where(and(eq(accounts.organizationId, org), eq(accounts.id, ref.id)));
      if (a) {
        rec = new VRecord(
          new Map<string, Value>([
            ["id", a.id],
            ["number", a.number],
            ["name", a.name],
            ["type", a.type],
            ["subtype", a.subtype],
          ]),
          undefined,
          "Account",
          true,
        );
      }
    } else {
      const [r] = await this.tx
        .select()
        .from(configRecords)
        .where(and(eq(configRecords.organizationId, org), eq(configRecords.id, ref.id), eq(configRecords.typeName, ref.type)));
      if (r) {
        rec = toRuntimeRecord(this.schema, r);
        rec.frozen = true;
      }
    }
    if (!rec) this.fail(`${ref.type} ${ref.id} does not exist in this organization.`, pos);
    this.refs.set(key, rec);
    return rec;
  }

  async account(key: string, pos: Pos): Promise<VRef> {
    const systemKey = ACCOUNT_KEYS[key];
    if (!systemKey) this.fail(`accounts has no "${key}". Use ${Object.keys(ACCOUNT_KEYS).join(", ")} or accounts.number("6500").`, pos);
    const [a] = await this.tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, this.ctx.organizationId), eq(accounts.systemKey, systemKey)));
    if (!a) this.fail(`The organization has no ${key} account.`, pos);
    return new VRef("Account", a.id);
  }

  async accountByNumber(number: string, pos: Pos): Promise<VRef> {
    const [a] = await this.tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, this.ctx.organizationId), eq(accounts.number, number)));
    if (!a) this.fail(`There is no account number ${number}.`, pos);
    return new VRef("Account", a.id);
  }

  private needPosting(pos: Pos): PostingState {
    if (!this.posting) this.fail("This can only be done while a document posts.", pos);
    return this.posting;
  }

  /**
   * Control accounts belong to their subledgers (invoices, bills, stock), so
   * code may not post to them directly; otherwise AR, AP and Inventory would
   * stop matching the documents behind them.
   */
  private async assertPostable(ref: VRef, pos: Pos) {
    const [a] = await this.tx
      .select({ systemKey: accounts.systemKey, name: accounts.name, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.organizationId, this.ctx.organizationId), eq(accounts.id, ref.id)));
    if (!a) this.fail("The account does not exist in this organization.", pos);
    if (a.systemKey && CONTROL_ACCOUNTS.has(a.systemKey)) {
      this.fail(`${a.name} is a control account kept by ${CONTROL_ACCOUNTS.get(a.systemKey)}; code cannot post to it directly.`, pos);
    }
    if (!a.isActive) this.fail(`${a.name} is archived.`, pos);
  }

  async ledgerPost(a: { debit: VRef; credit: VRef; amount: Dec; party: VRef | null; memo: string | null }, pos: Pos) {
    const p = this.needPosting(pos);
    const amount = a.amount.toDecimalPlaces(2, D.ROUND_HALF_UP);
    if (amount.isNegative()) this.fail("ledger.post needs a positive amount; swap debit and credit instead.", pos);
    if (a.party && a.party.type !== "Customer" && a.party.type !== "Vendor") this.fail("party must be a Customer or Vendor.", pos);
    await this.assertPostable(a.debit, pos);
    await this.assertPostable(a.credit, pos);
    if (amount.isZero()) return;
    const description = a.memo ?? `${p.number}`;
    p.ledger.push({ accountId: a.debit.id, debit: cents(amount), partyId: a.party?.id ?? null, description });
    p.ledger.push({ accountId: a.credit.id, credit: cents(amount), partyId: a.party?.id ?? null, description });
  }

  private async stockSource(item: VRef, pos: Pos) {
    const p = this.needPosting(pos);
    const [i] = await this.tx
      .select({ type: items.type, sku: items.sku, inventoryAccountId: items.inventoryAccountId, cogsAccountId: items.cogsAccountId })
      .from(items)
      .where(and(eq(items.organizationId, this.ctx.organizationId), eq(items.id, item.id)));
    if (!i) this.fail("The item does not exist.", pos);
    if (i.type !== "inventory") this.fail(`${i.sku} is not a stocked item.`, pos);
    return {
      p,
      item: i,
      src: {
        organizationId: this.ctx.organizationId,
        itemId: item.id,
        locationId: await defaultLocationId(this.tx, this.ctx.organizationId),
        date: p.date,
        sourceType: "config_document",
        sourceId: p.recordId,
        sourceNumber: p.number,
      },
    };
  }

  async stockReceive(item: VRef, qty: Dec, cost: Dec, credit: VRef, pos: Pos) {
    if (qty.lte(0)) this.fail("stock.receive needs a quantity above zero.", pos);
    if (cost.isNegative()) this.fail("stock.receive needs a cost of zero or more.", pos);
    await this.assertPostable(credit, pos);
    const { p, item: i, src } = await this.stockSource(item, pos);
    const value = await receiveStock(this.tx, { ...src, quantity: qty.toFixed(), value: cents(cost) });
    if (dec(value).isZero()) return;
    p.ledger.push({ accountId: i.inventoryAccountId!, debit: value, description: `${i.sku} received (${p.number})` });
    p.ledger.push({ accountId: credit.id, credit: value, description: `${i.sku} received (${p.number})` });
  }

  async stockIssue(item: VRef, qty: Dec, debit: VRef | null, pos: Pos): Promise<Dec> {
    if (qty.lte(0)) this.fail("stock.issue needs a quantity above zero.", pos);
    if (debit) await this.assertPostable(debit, pos);
    const { p, item: i, src } = await this.stockSource(item, pos);
    const cost = await issueStock(this.tx, { ...src, quantity: qty.toFixed() });
    if (!dec(cost).isZero()) {
      p.ledger.push({ accountId: debit?.id ?? i.cogsAccountId!, debit: cost, description: `${i.sku} issued (${p.number})` });
      p.ledger.push({ accountId: i.inventoryAccountId!, credit: cost, description: `${i.sku} issued (${p.number})` });
    }
    return dec(cost);
  }

  private registerFields(name: string, values: Map<string, Value>, pos: Pos, forBalance: boolean) {
    const reg = this.schema.registers.get(name)!;
    const dims: Record<string, string | null> = {};
    const res: Record<string, string> = {};
    for (const [k, v] of values) {
      const d = reg.dimensions.find((f) => f.name === k);
      const r = reg.resources.find((f) => f.name === k);
      if (d) dims[k] = dimensionKey(d, v, `${name}.${k}`);
      else if (r && !forBalance) {
        if (!isDec(v)) this.fail(`${name}.${k} must be a number.`, pos);
        res[k] = valueToStored(r, v, `${name}.${k}`) as string;
      } else this.fail(`Register ${name} has no ${forBalance ? "dimension" : "dimension or resource"} "${k}".`, pos);
    }
    if (!forBalance) {
      for (const d of reg.dimensions) if (!(d.name in dims)) this.fail(`${name} needs a value for dimension "${d.name}".`, pos);
      for (const r of reg.resources) res[r.name] ??= "0";
    }
    return { reg, dims, res };
  }

  async registerMove(name: string, sign: 1 | -1, values: Map<string, Value>, pos: Pos) {
    const p = this.needPosting(pos);
    const { reg, dims, res } = this.registerFields(name, values, pos, false);
    const signed = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, sign === 1 ? v : dec(v).negated().toFixed()]));
    await this.tx.insert(registerMovements).values({
      organizationId: this.ctx.organizationId,
      register: reg.name,
      recorderId: p.recordId,
      period: p.date,
      dimensions: dims,
      resources: signed,
    });
    const touched = p.touched.get(reg.name) ?? new Map();
    touched.set(JSON.stringify(dims), dims);
    p.touched.set(reg.name, touched);
  }

  async registerBalance(name: string, filters: Map<string, Value>, pos: Pos): Promise<VRecord> {
    const { reg, dims } = this.registerFields(name, filters, pos, true);
    const balances = await registerBalances(this.tx, this.ctx.organizationId, reg.name, reg.resources.map((r) => r.name), dims);
    return new VRecord(new Map(Object.entries(balances).map(([k, v]) => [k, v as Value])), undefined, `${name} balance`, true);
  }

  async find(type: string, filters: Map<string, Value>, pos: Pos): Promise<VRef | null> {
    const { decl } = resolveType(this.schema, type);
    const stored: Record<string, unknown> = {};
    for (const [k, v] of filters) {
      const f = decl.fields.find((x) => x.name === k);
      if (!f) this.fail(`${type} has no field "${k}".`, pos);
      stored[k] = valueToStored(f, v, `${type}.${k}`);
    }
    const [r] = await this.tx
      .select({ id: configRecords.id })
      .from(configRecords)
      .where(
        and(
          eq(configRecords.organizationId, this.ctx.organizationId),
          eq(configRecords.typeName, type),
          sql`${configRecords.data} @> ${JSON.stringify(stored)}::jsonb`,
        ),
      )
      .orderBy(configRecords.createdAt)
      .limit(1);
    return r ? new VRef(type, r.id) : null;
  }

  message(text: string) {
    if (this.messages.length < 50) this.messages.push(text);
  }

  today() {
    return today();
  }
}

/** Sum resources for movements matching the given dimensions (all of them when empty). */
export async function registerBalances(db: DbOrTx, organizationId: string, register: string, resources: string[], dims: Record<string, string | null>) {
  const out: Record<string, Dec> = {};
  const rows = await db
    .select({ resources: registerMovements.resources })
    .from(registerMovements)
    .where(
      and(
        eq(registerMovements.organizationId, organizationId),
        eq(registerMovements.register, register),
        sql`${registerMovements.dimensions} @> ${JSON.stringify(dims)}::jsonb`,
      ),
    );
  for (const r of resources) out[r] = new D(0);
  for (const row of rows) for (const r of resources) out[r] = out[r]!.plus(row.resources[r] ?? "0");
  return out;
}

// ------------------------------------------------------------------ records

type StoredRecord = typeof configRecords.$inferSelect;

/** Runtime object for a stored record: fields, system fields and table rows. */
export function toRuntimeRecord(schema: Schema, r: StoredRecord): VRecord {
  const { kind, decl } = resolveType(schema, r.typeName);
  const extra = new Map<string, Value>([["id", r.id]]);
  if (kind === "document") {
    extra.set("number", r.number);
    extra.set("date", r.date ? new VDate(r.date) : null);
    extra.set("posted", r.posted);
    for (const t of (decl as DocumentDecl).tables) {
      extra.set(
        t.name,
        (r.tables[t.name] ?? []).map((row) => recordFromStored(t.columns, row, `${t.name} row`)),
      );
    }
  }
  return recordFromStored(decl.fields, r.data, decl.name, extra);
}

export type RecordInput = {
  date?: string;
  data?: Record<string, unknown>;
  tables?: Record<string, Record<string, unknown>[]>;
};

function members(kind: "catalog" | "document", decl: CatalogDecl | DocumentDecl) {
  const base = decl.fields.map((f) => f.name);
  return kind === "document" ? [...DOCUMENT_SYSTEM_FIELDS, ...base, ...(decl as DocumentDecl).tables.map((t) => t.name)] : base;
}

/**
 * Create or update a catalog item or document: validate input, run "on write",
 * check types, required fields and references, then store. Posted documents are
 * unposted first (and reposted by the caller if asked).
 */
export async function saveRecord(
  tx: Tx,
  ctx: OrgContext,
  schema: Schema,
  typeName: string,
  input: RecordInput,
  existing: StoredRecord | null,
) {
  const { kind, decl } = resolveType(schema, typeName);
  const allowedFields = new Set(decl.fields.map((f) => f.name));
  for (const k of Object.keys(input.data ?? {})) if (!allowedFields.has(k)) throw invalid(`${decl.name} has no field "${k}".`);
  const tablesDecl = kind === "document" ? (decl as DocumentDecl).tables : [];
  for (const k of Object.keys(input.tables ?? {})) if (!tablesDecl.some((t) => t.name === k)) throw invalid(`${decl.name} has no table "${k}".`);

  // Input → stored draft (keeping fields that a newer/older configuration may not know).
  const data: Record<string, unknown> = { ...(existing?.data ?? {}) };
  for (const f of decl.fields) if (input.data && f.name in input.data) data[f.name] = inputToStored(f, input.data[f.name], f.name);
  const tables: Record<string, Record<string, unknown>[]> = { ...(existing?.tables ?? {}) };
  for (const t of tablesDecl) {
    if (!input.tables || !(t.name in input.tables)) continue;
    const rows = input.tables[t.name];
    if (!Array.isArray(rows)) throw invalid(`Table ${t.name} must be a list of rows.`);
    if (rows.length > 1000) throw invalid(`Table ${t.name} can have at most 1,000 rows.`);
    tables[t.name] = rows.map((row, i) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(row ?? {})) if (!t.columns.some((c) => c.name === k)) throw invalid(`Table ${t.name} has no column "${k}".`);
      for (const c of t.columns) out[c.name] = inputToStored(c, row?.[c.name], `${t.name} row ${i + 1}, ${c.name}`);
      return out;
    });
  }
  const date = kind === "document" ? (input.date ?? existing?.date ?? today()) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid("Enter the document date as YYYY-MM-DD.");

  // Run "on write" on a runtime copy, then convert back with type checks.
  const self = toRuntimeRecord(schema, {
    ...(existing ?? ({} as StoredRecord)),
    id: existing?.id ?? "",
    typeName,
    number: existing?.number ?? null,
    date,
    posted: false,
    data,
    tables,
  } as StoredRecord);
  const host = new KernelHost(tx, ctx, schema, null);
  const onWrite = decl.handlers.find((h) => h.event === "write");
  if (onWrite) {
    try {
      await new Interpreter(schema, host, "write").runHandler(onWrite, self, members(kind, decl));
    } catch (err) {
      throw fromVeko(err);
    }
  }
  const finalData: Record<string, unknown> = { ...data };
  for (const f of decl.fields) finalData[f.name] = valueToStored(f, self.fields.get(f.name) ?? null, f.name);
  const finalTables: Record<string, Record<string, unknown>[]> = { ...tables };
  for (const t of tablesDecl) {
    const rows = self.fields.get(t.name);
    if (!Array.isArray(rows)) throw invalid(`Table ${t.name} was replaced with something that is not a list.`);
    finalTables[t.name] = rows.map((row, i) => {
      if (!(row instanceof VRecord)) throw invalid(`Table ${t.name} row ${i + 1} is not a row.`);
      return Object.fromEntries(t.columns.map((c) => [c.name, valueToStored(c, row.fields.get(c.name) ?? null, `${t.name} row ${i + 1}, ${c.name}`)]));
    });
  }
  const finalDate = kind === "document" ? (self.fields.get("date") instanceof VDate ? (self.fields.get("date") as VDate).iso : date) : null;

  // Required fields and references.
  for (const f of decl.fields) if (f.required && finalData[f.name] === null) throw invalid(`${f.name} is required.`, { field: f.name });
  for (const t of tablesDecl) {
    (finalTables[t.name] ?? []).forEach((row, i) => {
      for (const c of t.columns) if (c.required && row[c.name] === null) throw invalid(`${t.name} row ${i + 1}: ${c.name} is required.`, { field: `${t.name}.${i}.${c.name}` });
    });
  }
  await checkReferences(tx, ctx.organizationId, schema, [
    ...decl.fields.map((f) => [f, finalData[f.name]] as const),
    ...tablesDecl.flatMap((t) => (finalTables[t.name] ?? []).flatMap((row) => t.columns.map((c) => [c, row[c.name]] as const))),
  ]);

  let saved: StoredRecord;
  if (existing) {
    [saved] = (await tx
      .update(configRecords)
      .set({ data: finalData, tables: finalTables, date: finalDate, updatedAt: new Date() })
      .where(eq(configRecords.id, existing.id))
      .returning()) as [StoredRecord];
  } else {
    const number = kind === "document" ? await nextConfigDocumentNumber(tx, ctx.organizationId, typeName) : null;
    [saved] = (await tx
      .insert(configRecords)
      .values({
        organizationId: ctx.organizationId,
        kind,
        typeName,
        number,
        date: finalDate,
        data: finalData,
        tables: finalTables,
        createdBy: ctx.userId,
      })
      .returning()) as [StoredRecord];
  }
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: existing ? "config_record.updated" : "config_record.created",
    entityType: typeName,
    entityId: saved.id,
    summary: `${existing ? "Updated" : "Created"} ${typeName}${saved.number ? ` ${saved.number}` : ""}`,
    ip: ctx.ip,
  });
  return { record: saved, messages: host.messages };
}

async function checkReferences(tx: Tx, organizationId: string, schema: Schema, pairs: (readonly [FieldDecl, unknown])[]) {
  const byType = new Map<string, Set<string>>();
  for (const [f, v] of pairs) {
    if (v === null || v === undefined || !isRefType(f.type.name)) continue;
    const set = byType.get(f.type.name) ?? new Set<string>();
    set.add(String(v));
    byType.set(f.type.name, set);
  }
  for (const [type, idSet] of byType) {
    const ids = [...idSet];
    let found: { id: string }[];
    if (type === "Customer" || type === "Vendor") {
      found = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.organizationId, organizationId), eq(parties.kind, type === "Customer" ? "customer" : "vendor"), inArray(parties.id, ids)));
    } else if (type === "Item") {
      found = await tx.select({ id: items.id }).from(items).where(and(eq(items.organizationId, organizationId), inArray(items.id, ids)));
    } else if (type === "Account") {
      found = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, ids)));
    } else {
      resolveType(schema, type);
      found = await tx
        .select({ id: configRecords.id })
        .from(configRecords)
        .where(and(eq(configRecords.organizationId, organizationId), eq(configRecords.typeName, type), inArray(configRecords.id, ids)));
    }
    if (found.length !== ids.length) throw invalid(`A selected ${type} does not exist in this organization.`);
  }
}

// ------------------------------------------------------------------ posting

export async function lockRecord(tx: Tx, organizationId: string, typeName: string, id: string) {
  const [r] = await tx
    .select()
    .from(configRecords)
    .where(and(eq(configRecords.organizationId, organizationId), eq(configRecords.typeName, typeName), eq(configRecords.id, id)))
    .for("update");
  if (!r) throw notFound(typeName);
  return r;
}

/**
 * Undo a document's posting: delete its register movements, reverse its
 * journal entry, put its stock moves back, and re-check nonnegative registers.
 */
export async function unpostRecord(tx: Tx, ctx: OrgContext, schema: Schema, rec: StoredRecord, date: string) {
  if (!rec.posted) return rec;
  const removed = await tx
    .delete(registerMovements)
    .where(and(eq(registerMovements.organizationId, ctx.organizationId), eq(registerMovements.recorderId, rec.id)))
    .returning({ register: registerMovements.register, dimensions: registerMovements.dimensions });
  let reversalId: string | null = null;
  if (rec.journalEntryId) {
    const reversal = await reverseJournalEntry(tx, {
      organizationId: ctx.organizationId,
      entryId: rec.journalEntryId,
      date: date < (rec.date ?? date) ? (rec.date ?? date) : date,
      memo: `Unpost ${rec.typeName} ${rec.number}`,
      createdBy: ctx.userId,
      sourceType: "config_document",
      sourceId: rec.id,
      sourceNumber: rec.number,
    });
    reversalId = reversal.id;
  }
  // Net stock moves of this document, undone exactly.
  const net = await tx
    .select({
      itemId: stockMoves.itemId,
      locationId: stockMoves.locationId,
      quantity: sql<string>`sum(${stockMoves.quantity})::text`,
      value: sql<string>`sum(${stockMoves.valueChange})::text`,
    })
    .from(stockMoves)
    .where(and(eq(stockMoves.organizationId, ctx.organizationId), eq(stockMoves.sourceId, rec.id)))
    .groupBy(stockMoves.itemId, stockMoves.locationId);
  for (const n of net.sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const q = dec(n.quantity);
    const v = dec(n.value);
    if (q.isZero() && v.isZero()) continue;
    const src = { organizationId: ctx.organizationId, itemId: n.itemId, locationId: n.locationId, date: rec.date ?? date, sourceType: "config_document", sourceId: rec.id, sourceNumber: rec.number };
    if (q.lt(0)) await receiveStock(tx, { ...src, quantity: q.negated().toFixed(), value: cents(v.negated()) });
    else await removeStockExact(tx, { ...src, quantity: q.toFixed(), value: cents(v) });
  }
  if (reversalId) await linkMovesToEntry(tx, ctx.organizationId, rec.id, reversalId);

  const touched = new Map<string, Map<string, Record<string, string | null>>>();
  for (const m of removed) {
    const t = touched.get(m.register) ?? new Map();
    t.set(JSON.stringify(m.dimensions), m.dimensions);
    touched.set(m.register, t);
  }
  await checkNonnegative(tx, ctx.organizationId, schema, touched);
  const [updated] = await tx
    .update(configRecords)
    .set({ posted: false, journalEntryId: null, updatedAt: new Date() })
    .where(eq(configRecords.id, rec.id))
    .returning();
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "config_record.unposted",
    entityType: rec.typeName,
    entityId: rec.id,
    summary: `Unposted ${rec.typeName} ${rec.number}`,
    ip: ctx.ip,
  });
  return updated!;
}

async function checkNonnegative(tx: Tx, organizationId: string, schema: Schema, touched: Map<string, Map<string, Record<string, string | null>>>) {
  for (const [name, combos] of touched) {
    const reg = schema.registers.get(name);
    if (!reg?.nonnegative) continue;
    for (const dims of combos.values()) {
      const bal = await registerBalances(tx, organizationId, name, reg.resources.map((r) => r.name), dims);
      for (const [res, value] of Object.entries(bal)) {
        if (value.isNegative()) {
          const where = Object.entries(dims)
            .map(([k, v]) => `${k} ${v ?? "empty"}`)
            .join(", ");
          throw new AppError(422, "negative_balance", `${name}: ${res} would fall to ${value.toFixed()} for ${where}. Nothing was posted.`, {
            register: name,
            resource: res,
            dimensions: dims,
          });
        }
      }
    }
  }
}

/** Post a document: undo any previous posting, run "on post", post one journal entry, check registers. */
export async function postRecord(tx: Tx, ctx: OrgContext, schema: Schema, recIn: StoredRecord) {
  const { kind, decl } = resolveType(schema, recIn.typeName);
  if (kind !== "document") throw invalid(`${recIn.typeName} is a catalog; only documents post.`);
  const rec = recIn.posted ? await unpostRecord(tx, ctx, schema, recIn, recIn.date ?? today()) : recIn;
  const posting: PostingState = { recordId: rec.id, number: rec.number ?? rec.id, date: rec.date ?? today(), ledger: [], touched: new Map() };
  const host = new KernelHost(tx, ctx, schema, posting);
  const self = toRuntimeRecord(schema, { ...rec, posted: true });
  self.frozen = true;
  for (const v of self.fields.values()) if (Array.isArray(v)) for (const row of v) if (row instanceof VRecord) row.frozen = true;
  const onPost = decl.handlers.find((h) => h.event === "post");
  if (onPost) {
    try {
      await new Interpreter(schema, host, "post").runHandler(onPost, self, members(kind, decl));
    } catch (err) {
      throw fromVeko(err);
    }
  }
  let journalEntryId: string | null = null;
  if (posting.ledger.length > 0) {
    const entry = await postJournalEntry(tx, {
      organizationId: ctx.organizationId,
      date: posting.date,
      memo: `${rec.typeName} ${rec.number}`,
      sourceType: "config_document",
      sourceId: rec.id,
      sourceNumber: rec.number,
      createdBy: ctx.userId,
      lines: posting.ledger,
    });
    journalEntryId = entry.id;
    await linkMovesToEntry(tx, ctx.organizationId, rec.id, entry.id);
  }
  await checkNonnegative(tx, ctx.organizationId, schema, posting.touched);
  const [updated] = await tx
    .update(configRecords)
    .set({ posted: true, journalEntryId, updatedAt: new Date() })
    .where(eq(configRecords.id, rec.id))
    .returning();
  await audit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "config_record.posted",
    entityType: rec.typeName,
    entityId: rec.id,
    summary: `Posted ${rec.typeName} ${rec.number}`,
    data: { journalEntryId },
    ip: ctx.ip,
  });
  return { record: updated!, messages: host.messages };
}

// ------------------------------------------------------------------- labels

/** Human labels for every reference in a set of records, by id. */
export async function referenceLabels(db: DbOrTx, organizationId: string, schema: Schema, recs: StoredRecord[]) {
  const byType = new Map<string, Set<string>>();
  const add = (type: string, id: unknown) => {
    if (typeof id !== "string") return;
    const s = byType.get(type) ?? new Set<string>();
    s.add(id);
    byType.set(type, s);
  };
  for (const r of recs) {
    const { kind, decl } = resolveType(schema, r.typeName);
    for (const f of decl.fields) if (isRefType(f.type.name)) add(f.type.name, r.data[f.name]);
    if (kind === "document") {
      for (const t of (decl as DocumentDecl).tables) for (const row of r.tables[t.name] ?? []) for (const c of t.columns) if (isRefType(c.type.name)) add(c.type.name, row[c.name]);
    }
  }
  return labelsFor(db, organizationId, schema, byType);
}

export async function labelsFor(db: DbOrTx, organizationId: string, schema: Schema, byType: Map<string, Set<string>>) {
  const labels: Record<string, string> = {};
  for (const [type, idSet] of byType) {
    const ids = [...idSet];
    if (ids.length === 0) continue;
    if (type === "Customer" || type === "Vendor") {
      for (const p of await db.select({ id: parties.id, n: parties.displayName }).from(parties).where(and(eq(parties.organizationId, organizationId), inArray(parties.id, ids)))) labels[p.id] = p.n;
    } else if (type === "Item") {
      for (const i of await db.select({ id: items.id, sku: items.sku, name: items.name }).from(items).where(and(eq(items.organizationId, organizationId), inArray(items.id, ids)))) labels[i.id] = `${i.sku} ${i.name}`;
    } else if (type === "Account") {
      for (const a of await db.select({ id: accounts.id, n: accounts.number, name: accounts.name }).from(accounts).where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, ids)))) labels[a.id] = `${a.n} ${a.name}`;
    } else if (!isKernelType(type)) {
      const rows = await db.select().from(configRecords).where(and(eq(configRecords.organizationId, organizationId), inArray(configRecords.id, ids)));
      for (const r of rows) labels[r.id] = recordLabel(schema, r);
    }
  }
  return labels;
}

/** A catalog item's first text field, or a document's number. */
export function recordLabel(schema: Schema, r: StoredRecord) {
  if (r.number) return r.number;
  const decl = schema.catalogs.get(r.typeName);
  const textField = decl?.fields.find((f) => f.type.name === "Text");
  const v = textField ? r.data[textField.name] : null;
  return typeof v === "string" && v ? v : `${r.typeName} ${r.id.slice(0, 8)}`;
}
