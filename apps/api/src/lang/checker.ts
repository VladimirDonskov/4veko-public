import {
  VekoError,
  type CatalogDecl,
  type DocumentDecl,
  type Expr,
  type FieldDecl,
  type FunctionDecl,
  type Pos,
  type Program,
  type RegisterDecl,
  type Stmt,
} from "./ast";
import { parse } from "./parser";

export const SCALAR_TYPES = ["Text", "Number", "Money", "Quantity", "Date", "Boolean"] as const;
export const KERNEL_TYPES = ["Customer", "Vendor", "Item", "Account"] as const;
export const NUMERIC_TYPES = new Set(["Number", "Money", "Quantity"]);
/** Built-in names available everywhere. */
export const BUILTINS = [
  "ledger",
  "stock",
  "accounts",
  "today",
  "toDate",
  "addDays",
  "daysBetween",
  "round",
  "abs",
  "min",
  "max",
  "len",
  "text",
  "number",
  "upper",
  "lower",
  "message",
] as const;
/** Fields every document has, managed by the platform. */
export const DOCUMENT_SYSTEM_FIELDS = ["number", "date", "posted"] as const;

export type Schema = {
  catalogs: Map<string, CatalogDecl>;
  documents: Map<string, DocumentDecl>;
  registers: Map<string, RegisterDecl>;
  functions: Map<string, FunctionDecl>;
};

export type CheckResult = { schema: Schema; diagnostics: VekoError[] };

/** Parse and check a configuration. Syntax errors stop at the first; check errors are all collected. */
export function compile(source: string): CheckResult {
  let program: Program;
  try {
    program = parse(source);
  } catch (err) {
    if (err instanceof VekoError) return { schema: emptySchema(), diagnostics: [err] };
    throw err;
  }
  return check(program);
}

function emptySchema(): Schema {
  return { catalogs: new Map(), documents: new Map(), registers: new Map(), functions: new Map() };
}

export function check(program: Program): CheckResult {
  const schema = emptySchema();
  const diagnostics: VekoError[] = [];
  const err = (message: string, pos: Pos) => diagnostics.push(new VekoError(message, pos, "check"));
  const reserved = new Set<string>([...SCALAR_TYPES, ...KERNEL_TYPES, ...BUILTINS]);
  const topNames = new Map<string, Pos>();

  for (const d of program.decls) {
    if (reserved.has(d.name)) err(`"${d.name}" is a built-in name; choose another.`, d.pos);
    else if (topNames.has(d.name)) err(`"${d.name}" is already declared on line ${topNames.get(d.name)!.line}.`, d.pos);
    else topNames.set(d.name, d.pos);
    if (d.kind === "catalog") schema.catalogs.set(d.name, d);
    else if (d.kind === "document") schema.documents.set(d.name, d);
    else if (d.kind === "register") schema.registers.set(d.name, d);
    else schema.functions.set(d.name, d);
  }

  const validType = (t: string) =>
    (SCALAR_TYPES as readonly string[]).includes(t) || (KERNEL_TYPES as readonly string[]).includes(t) || schema.catalogs.has(t) || schema.documents.has(t);

  const checkFields = (fields: FieldDecl[], taken: Set<string>, owner: string) => {
    for (const f of fields) {
      if (taken.has(f.name)) err(`${owner} already has a member named "${f.name}".`, f.pos);
      taken.add(f.name);
      if (!validType(f.type.name)) {
        err(`Unknown type "${f.type.name}". Use ${SCALAR_TYPES.join(", ")}, ${KERNEL_TYPES.join(", ")}, or a catalog or document name.`, f.type.pos);
      }
    }
  };

  for (const c of schema.catalogs.values()) {
    const taken = new Set<string>(["id"]);
    checkFields(c.fields, taken, `Catalog ${c.name}`);
    if (c.fields.length === 0) err(`Catalog ${c.name} needs at least one field.`, c.pos);
    checkHandlers(c.handlers.map((h) => h.event), c.handlers.map((h) => h.pos), err);
  }
  for (const d of schema.documents.values()) {
    const taken = new Set<string>(["id", ...DOCUMENT_SYSTEM_FIELDS]);
    for (const f of d.fields) if ((DOCUMENT_SYSTEM_FIELDS as readonly string[]).includes(f.name)) err(`"${f.name}" is managed by the platform and cannot be declared.`, f.pos);
    checkFields(d.fields.filter((f) => !(DOCUMENT_SYSTEM_FIELDS as readonly string[]).includes(f.name)), taken, `Document ${d.name}`);
    for (const t of d.tables) {
      if (taken.has(t.name)) err(`Document ${d.name} already has a member named "${t.name}".`, t.pos);
      taken.add(t.name);
      if (t.columns.length === 0) err(`Table ${t.name} needs at least one column.`, t.pos);
      checkFields(t.columns, new Set(["lineNo"]), `Table ${t.name}`);
    }
    checkHandlers(d.handlers.map((h) => h.event), d.handlers.map((h) => h.pos), err);
  }
  for (const r of schema.registers.values()) {
    const taken = new Set<string>(["period", "recorder"]);
    checkFields([...r.dimensions, ...r.resources], taken, `Register ${r.name}`);
    if (r.dimensions.length === 0) err(`Register ${r.name} needs at least one dimension.`, r.pos);
    if (r.resources.length === 0) err(`Register ${r.name} needs at least one resource.`, r.pos);
    for (const res of r.resources) {
      if (!NUMERIC_TYPES.has(res.type.name)) err(`Resource "${res.name}" must be Number, Money or Quantity.`, res.type.pos);
    }
  }
  for (const f of schema.functions.values()) {
    const seen = new Set<string>();
    for (const p of f.params) {
      if (seen.has(p)) err(`Parameter "${p}" appears twice.`, f.pos);
      seen.add(p);
    }
  }

  // Name resolution and context rules, per body.
  const globals = new Set<string>([...BUILTINS, ...topNames.keys()]);
  const walker = new Walker(schema, globals, err);
  for (const c of schema.catalogs.values()) {
    for (const h of c.handlers) walker.body(h.body, new Set([...c.fields.map((f) => f.name)]), h.event, `catalog ${c.name}`);
  }
  for (const d of schema.documents.values()) {
    const members = new Set<string>([...DOCUMENT_SYSTEM_FIELDS, ...d.fields.map((f) => f.name), ...d.tables.map((t) => t.name)]);
    for (const h of d.handlers) walker.body(h.body, members, h.event, `document ${d.name}`);
  }
  for (const f of schema.functions.values()) walker.body(f.body, new Set(), "function", `function ${f.name}`, f.params);

  return { schema, diagnostics };
}

function checkHandlers(events: string[], positions: Pos[], err: (m: string, p: Pos) => void) {
  const seen = new Set<string>();
  events.forEach((e, i) => {
    if (seen.has(e)) err(`There is already an "on ${e}" handler.`, positions[i]!);
    seen.add(e);
  });
}

type Context = "write" | "post" | "function";

class Walker {
  constructor(
    private schema: Schema,
    private globals: Set<string>,
    private err: (m: string, p: Pos) => void,
  ) {}

  private members = new Set<string>();
  private context: Context = "function";
  private where = "";
  private loopDepth = 0;

  body(stmts: Stmt[], members: Set<string>, context: Context, where: string, params: string[] = []) {
    this.members = members;
    this.context = context;
    this.where = where;
    this.loopDepth = 0;
    this.block(stmts, [new Set(params)]);
  }

  private defined(name: string, scopes: Set<string>[]) {
    return scopes.some((s) => s.has(name)) || this.members.has(name) || this.globals.has(name);
  }

  private block(stmts: Stmt[], scopes: Set<string>[]) {
    const inner = [...scopes, new Set<string>()];
    for (const s of stmts) this.stmt(s, inner);
  }

  private stmt(s: Stmt, scopes: Set<string>[]) {
    switch (s.kind) {
      case "let": {
        this.expr(s.value, scopes);
        const top = scopes[scopes.length - 1]!;
        if (top.has(s.name)) this.err(`Variable "${s.name}" is already declared in this block.`, s.pos);
        if (this.globals.has(s.name) || this.members.has(s.name)) this.err(`"${s.name}" hides an existing name; choose another variable name.`, s.pos);
        top.add(s.name);
        return;
      }
      case "assign":
        this.expr(s.value, scopes);
        if (s.target.kind === "name") {
          const n = s.target.name;
          const isLocal = scopes.some((sc) => sc.has(n));
          if (!isLocal && !this.members.has(n)) {
            this.err(this.globals.has(n) ? `"${n}" cannot be assigned.` : `Unknown variable "${n}". Declare it first with "let ${n} = …".`, s.target.pos);
          } else if (!isLocal && (n === "number" || n === "posted")) {
            this.err(`"${n}" is managed by the platform and cannot be changed.`, s.target.pos);
          } else if (!isLocal && this.context === "post") {
            this.err(`Fields cannot be changed in "on post"; change them in "on write".`, s.target.pos);
          }
        } else this.expr(s.target, scopes);
        return;
      case "if":
        for (const b of s.branches) {
          this.expr(b.cond, scopes);
          this.block(b.body, scopes);
        }
        if (s.otherwise) this.block(s.otherwise, scopes);
        return;
      case "for": {
        this.expr(s.iterable, scopes);
        this.loopDepth++;
        this.block(s.body, [...scopes, new Set([s.name])]);
        this.loopDepth--;
        return;
      }
      case "while":
        this.expr(s.cond, scopes);
        this.loopDepth++;
        this.block(s.body, scopes);
        this.loopDepth--;
        return;
      case "return":
        if (s.value) this.expr(s.value, scopes);
        return;
      case "fail":
        this.expr(s.message, scopes);
        return;
      case "break":
      case "continue":
        if (this.loopDepth === 0) this.err(`"${s.kind}" can only be used inside a loop.`, s.pos);
        return;
      case "expr":
        this.expr(s.expr, scopes);
        return;
    }
  }

  private expr(e: Expr, scopes: Set<string>[]) {
    switch (e.kind) {
      case "name":
        if (!this.defined(e.name, scopes)) this.err(`Unknown name "${e.name}" in ${this.where}.`, e.pos);
        return;
      case "this":
        if (this.where.startsWith("function")) this.err(`"this" is only available in catalog and document handlers.`, e.pos);
        return;
      case "list":
        e.items.forEach((i) => this.expr(i, scopes));
        return;
      case "record":
        e.entries.forEach((x) => this.expr(x.value, scopes));
        return;
      case "member":
        this.expr(e.object, scopes);
        return;
      case "index":
        this.expr(e.object, scopes);
        this.expr(e.index, scopes);
        return;
      case "unary":
        this.expr(e.operand, scopes);
        return;
      case "binary":
        this.expr(e.left, scopes);
        this.expr(e.right, scopes);
        return;
      case "call": {
        this.expr(e.callee, scopes);
        e.args.forEach((a) => this.expr(a, scopes));
        e.named.forEach((a) => this.expr(a.value, scopes));
        this.callRules(e, scopes);
        return;
      }
      default:
        return;
    }
  }

  private callRules(e: Extract<Expr, { kind: "call" }>, scopes: Set<string>[]) {
    const c = e.callee;
    // User functions: argument count.
    if (c.kind === "name" && !scopes.some((s) => s.has(c.name))) {
      const fn = this.schema.functions.get(c.name);
      if (fn) {
        const given = e.args.length + e.named.length;
        if (given !== fn.params.length) this.err(`${fn.name} expects ${fn.params.length} argument(s) but got ${given}.`, e.pos);
        for (const n of e.named) if (!fn.params.includes(n.name)) this.err(`${fn.name} has no parameter "${n.name}".`, e.pos);
      }
    }
    // Posting operations belong in "on post" (or functions it calls; checked at run time).
    if (c.kind === "member" && c.object.kind === "name" && !scopes.some((s) => s.has((c.object as { name: string }).name))) {
      const owner = c.object.name;
      const isPostingOp =
        (owner === "ledger" && c.name === "post") ||
        (owner === "stock" && (c.name === "issue" || c.name === "receive")) ||
        (this.schema.registers.has(owner) && (c.name === "add" || c.name === "subtract"));
      if (isPostingOp && this.context === "write") this.err(`${owner}.${c.name} can only be used in "on post".`, e.pos);
      const reg = this.schema.registers.get(owner);
      if (reg && ["add", "subtract", "balance"].includes(c.name)) {
        const allowed = new Set([...reg.dimensions, ...reg.resources].map((f) => f.name));
        for (const n of e.named) if (!allowed.has(n.name)) this.err(`Register ${reg.name} has no dimension or resource "${n.name}".`, e.pos);
        if (e.args.length) this.err(`Use named arguments with registers, for example ${reg.name}.${c.name}(${reg.dimensions[0]?.name ?? "dimension"}: …).`, e.pos);
      }
      if (reg && !["add", "subtract", "balance"].includes(c.name)) this.err(`Registers support add, subtract and balance, not "${c.name}".`, e.pos);
    }
  }
}
