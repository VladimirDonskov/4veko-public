import { D, type Dec } from "../lib/money";
import { VekoError, type Expr, type FunctionDecl, type Handler, type Pos, type Stmt } from "./ast";
import type { Schema } from "./checker";

// ------------------------------------------------------------------ values

export class VDate {
  constructor(public readonly iso: string) {}
}
/** A reference to a stored record: a catalog item, document, or kernel record (Customer, Item…). */
export class VRef {
  constructor(
    public readonly type: string,
    public readonly id: string,
  ) {}
}
/** A record with named fields: the current object, a table row, a register balance, a literal. */
export class VRecord {
  constructor(
    public readonly fields: Map<string, Value>,
    /** Declared field names; reading one that is unset gives null. Undefined means "any". */
    public readonly declared?: Set<string>,
    public readonly label = "record",
    public frozen = false,
  ) {}
  get(name: string, pos: Pos): Value {
    if (this.fields.has(name)) return this.fields.get(name)!;
    if (this.declared?.has(name)) return null;
    throw new VekoError(`${this.label} has no field "${name}".`, pos);
  }
  set(name: string, value: Value, pos: Pos) {
    if (this.frozen) throw new VekoError(`${this.label} cannot be changed here.`, pos);
    if (this.declared && !this.declared.has(name)) throw new VekoError(`${this.label} has no field "${name}".`, pos);
    this.fields.set(name, value);
  }
}
export type NativeFn = (args: Value[], named: Map<string, Value>, pos: Pos) => Promise<Value> | Value;
export class VNative {
  constructor(
    public readonly name: string,
    public readonly fn: NativeFn,
  ) {}
}
/** A namespace whose members are resolved by the host (accounts.receivable, Register.add…). */
export class VHost {
  constructor(
    public readonly label: string,
    public readonly member: (name: string, pos: Pos) => Promise<Value> | Value,
  ) {}
}
export type Value = Dec | string | boolean | null | VDate | VRef | VRecord | Value[] | VNative | VHost | FunctionDecl;

export const isDec = (v: Value): v is Dec => v instanceof D;

export function typeName(v: Value): string {
  if (v === null) return "null";
  if (isDec(v)) return "number";
  if (typeof v === "string") return "text";
  if (typeof v === "boolean") return "true/false";
  if (v instanceof VDate) return "date";
  if (v instanceof VRef) return v.type;
  if (v instanceof VRecord) return v.label;
  if (Array.isArray(v)) return "list";
  if (v instanceof VNative || (typeof v === "object" && "kind" in v && v.kind === "function")) return "function";
  return "object";
}

export function show(v: Value): string {
  if (v === null) return "null";
  if (isDec(v)) return v.toFixed();
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof VDate) return v.iso;
  if (v instanceof VRef) return `${v.type}(${v.id})`;
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (v instanceof VRecord) return `{${[...v.fields].map(([k, x]) => `${k}: ${show(x)}`).join(", ")}}`;
  return typeName(v);
}

// -------------------------------------------------------------------- host

/** Everything code can do outside pure computation goes through the host (the platform kernel). */
export interface Host {
  loadRef(ref: VRef, pos: Pos): Promise<VRecord>;
  account(key: string, pos: Pos): Promise<VRef>;
  accountByNumber(number: string, pos: Pos): Promise<VRef>;
  ledgerPost(args: { debit: VRef; credit: VRef; amount: Dec; party: VRef | null; memo: string | null }, pos: Pos): Promise<void>;
  /** Receive stock and post Dr Inventory / Cr `credit` at the given cost. */
  stockReceive(item: VRef, qty: Dec, cost: Dec, credit: VRef, pos: Pos): Promise<void>;
  /** Issue stock at average cost and post Dr `debit` (default COGS) / Cr Inventory. Returns the cost. */
  stockIssue(item: VRef, qty: Dec, debit: VRef | null, pos: Pos): Promise<Dec>;
  registerMove(register: string, sign: 1 | -1, values: Map<string, Value>, pos: Pos): Promise<void>;
  registerBalance(register: string, filters: Map<string, Value>, pos: Pos): Promise<VRecord>;
  find(type: string, filters: Map<string, Value>, pos: Pos): Promise<VRef | null>;
  message(text: string): void;
  today(): string;
}

export type Limits = { maxSteps: number; maxMillis: number; maxDepth: number; maxText: number };
export const DEFAULT_LIMITS: Limits = { maxSteps: 1_000_000, maxMillis: 2_000, maxDepth: 200, maxText: 1_000_000 };

class ReturnSignal {
  constructor(public value: Value) {}
}
class BreakSignal {}
class ContinueSignal {}

class Scope {
  private vars = new Map<string, Value>();
  constructor(private readonly parent: Scope | null) {}
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }
  get(name: string): Value | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }
  declare(name: string, value: Value) {
    this.vars.set(name, value);
  }
  set(name: string, value: Value): boolean {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return true;
    }
    return this.parent?.set(name, value) ?? false;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------- interpreter

export type RunMode = "write" | "post" | "function";

export class Interpreter {
  private steps = 0;
  private depth = 0;
  private readonly started = Date.now();
  private readonly globals = new Map<string, Value>();
  private self: VRecord | null = null;
  private selfMembers = new Set<string>();

  constructor(
    private readonly schema: Schema,
    private readonly host: Host,
    private readonly mode: RunMode,
    private readonly limits: Limits = DEFAULT_LIMITS,
  ) {
    this.installBuiltins();
  }

  /** Run an "on write" or "on post" handler against the current object. */
  async runHandler(handler: Handler, self: VRecord, members: string[]) {
    this.self = self;
    this.selfMembers = new Set(members);
    try {
      await this.block(handler.body, new Scope(null));
    } catch (e) {
      if (e instanceof ReturnSignal) return;
      throw e;
    }
  }

  /** Call a top-level function by name (used by tests and future reports). */
  async callFunction(name: string, args: Value[], pos: Pos = { line: 0, col: 0 }): Promise<Value> {
    const fn = this.schema.functions.get(name);
    if (!fn) throw new VekoError(`Unknown function "${name}".`, pos);
    return this.invoke(fn, args, new Map(), pos);
  }

  // ---------------------------------------------------------------- limits

  private tick(pos: Pos) {
    this.steps++;
    if (this.steps > this.limits.maxSteps) throw new VekoError(`The code ran too long (more than ${this.limits.maxSteps.toLocaleString("en-US")} steps). Is there an endless loop?`, pos, "limit");
    if ((this.steps & 1023) === 0 && Date.now() - this.started > this.limits.maxMillis) {
      throw new VekoError(`The code ran longer than ${this.limits.maxMillis / 1000} seconds.`, pos, "limit");
    }
  }

  private checkText(s: string, pos: Pos) {
    if (s.length > this.limits.maxText) throw new VekoError("Text is too long.", pos, "limit");
    return s;
  }

  // ------------------------------------------------------------ statements

  private async block(stmts: Stmt[], parent: Scope) {
    const scope = new Scope(parent);
    for (const s of stmts) await this.stmt(s, scope);
  }

  private async stmt(s: Stmt, scope: Scope): Promise<void> {
    this.tick(s.pos);
    switch (s.kind) {
      case "let":
        scope.declare(s.name, await this.eval(s.value, scope));
        return;
      case "assign":
        return this.assign(s.target, await this.eval(s.value, scope), scope, s.pos);
      case "if":
        for (const b of s.branches) {
          if (this.truth(await this.eval(b.cond, scope), b.cond.pos)) return this.block(b.body, scope);
        }
        if (s.otherwise) await this.block(s.otherwise, scope);
        return;
      case "for": {
        const it = await this.eval(s.iterable, scope);
        if (!Array.isArray(it)) throw new VekoError(`"for" needs a list or table, not ${typeName(it)}.`, s.iterable.pos);
        for (const item of [...it]) {
          const inner = new Scope(scope);
          inner.declare(s.name, item);
          try {
            await this.block(s.body, inner);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "while":
        while (this.truth(await this.eval(s.cond, scope), s.cond.pos)) {
          try {
            await this.block(s.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      case "return":
        throw new ReturnSignal(s.value ? await this.eval(s.value, scope) : null);
      case "fail": {
        const m = await this.eval(s.message, scope);
        throw new VekoError(typeof m === "string" ? m : show(m), s.pos, "fail");
      }
      case "break":
        throw new BreakSignal();
      case "continue":
        throw new ContinueSignal();
      case "expr":
        await this.eval(s.expr, scope);
        return;
    }
  }

  private async assign(target: Expr, value: Value, scope: Scope, pos: Pos) {
    if (target.kind === "name") {
      if (scope.set(target.name, value)) return;
      if (this.self && this.selfMembers.has(target.name)) {
        if (this.mode !== "write") throw new VekoError(`Fields cannot be changed in "on ${this.mode}".`, pos);
        if (target.name === "number" || target.name === "posted") throw new VekoError(`"${target.name}" is managed by the platform.`, pos);
        this.self.set(target.name, value, pos);
        return;
      }
      throw new VekoError(`Unknown variable "${target.name}".`, pos);
    }
    if (target.kind === "member") {
      const obj = await this.eval(target.object, scope);
      if (obj instanceof VRecord) {
        if (this.mode !== "write" && (obj === this.self || obj.declared)) throw new VekoError(`Fields cannot be changed in "on ${this.mode}".`, pos);
        obj.set(target.name, value, pos);
        return;
      }
      if (obj instanceof VRef) throw new VekoError(`A referenced ${obj.type} cannot be changed from here.`, pos);
      throw new VekoError(`Cannot set "${target.name}" on ${typeName(obj)}.`, pos);
    }
    if (target.kind === "index") {
      const list = await this.eval(target.object, scope);
      const idx = await this.eval(target.index, scope);
      if (!Array.isArray(list)) throw new VekoError(`Only list items can be assigned by index.`, pos);
      list[this.indexOf(list, idx, pos)] = value;
      return;
    }
    throw new VekoError("This cannot be assigned.", pos);
  }

  // ----------------------------------------------------------- expressions

  private async eval(e: Expr, scope: Scope): Promise<Value> {
    this.tick(e.pos);
    switch (e.kind) {
      case "number":
        return new D(e.value);
      case "string":
        return e.value;
      case "bool":
        return e.value;
      case "null":
        return null;
      case "this":
        if (!this.self) throw new VekoError(`"this" is not available here.`, e.pos);
        return this.self;
      case "name":
        return this.lookup(e.name, scope, e.pos);
      case "list": {
        const out: Value[] = [];
        for (const i of e.items) out.push(await this.eval(i, scope));
        return out;
      }
      case "record": {
        const m = new Map<string, Value>();
        for (const x of e.entries) m.set(x.key, await this.eval(x.value, scope));
        return new VRecord(m);
      }
      case "member":
        return this.member(await this.eval(e.object, scope), e.name, e.pos);
      case "index": {
        const obj = await this.eval(e.object, scope);
        const idx = await this.eval(e.index, scope);
        if (Array.isArray(obj)) return obj[this.indexOf(obj, idx, e.pos)]!;
        if (typeof obj === "string") return obj.charAt(this.indexOf([...obj], idx, e.pos));
        throw new VekoError(`Cannot index ${typeName(obj)}.`, e.pos);
      }
      case "unary": {
        const v = await this.eval(e.operand, e.op === "not" ? scope : scope);
        if (e.op === "not") return !this.truth(v, e.pos);
        if (!isDec(v)) throw new VekoError(`Cannot negate ${typeName(v)}.`, e.pos);
        return v.negated();
      }
      case "binary":
        return this.binary(e, scope);
      case "call": {
        const callee = await this.eval(e.callee, scope);
        const args: Value[] = [];
        for (const a of e.args) args.push(await this.eval(a, scope));
        const named = new Map<string, Value>();
        for (const n of e.named) named.set(n.name, await this.eval(n.value, scope));
        return this.invokeValue(callee, args, named, e.pos);
      }
    }
  }

  private lookup(name: string, scope: Scope, pos: Pos): Value {
    const local = scope.get(name);
    if (local !== undefined) return local;
    if (this.self && this.selfMembers.has(name)) return this.self.get(name, pos);
    const g = this.globals.get(name);
    if (g !== undefined) return g;
    const fn = this.schema.functions.get(name);
    if (fn) return fn;
    throw new VekoError(`Unknown name "${name}".`, pos);
  }

  private async member(obj: Value, name: string, pos: Pos): Promise<Value> {
    if (obj instanceof VRecord) return obj.get(name, pos);
    if (obj instanceof VRef) return (await this.host.loadRef(obj, pos)).get(name, pos);
    if (obj instanceof VHost) return obj.member(name, pos);
    if (obj === null) throw new VekoError(`Cannot read "${name}" of null (an empty field?).`, pos);
    throw new VekoError(`${typeName(obj)} has no member "${name}".`, pos);
  }

  private indexOf(list: unknown[], idx: Value, pos: Pos) {
    if (!isDec(idx) || !idx.isInteger()) throw new VekoError("An index must be a whole number.", pos);
    const i = idx.toNumber();
    if (i < 0 || i >= list.length) throw new VekoError(`Index ${i} is outside the list (length ${list.length}).`, pos);
    return i;
  }

  private truth(v: Value, pos: Pos): boolean {
    if (typeof v === "boolean") return v;
    throw new VekoError(`A condition must be true or false, not ${typeName(v)}.`, pos);
  }

  private async binary(e: Extract<Expr, { kind: "binary" }>, scope: Scope): Promise<Value> {
    if (e.op === "and") return this.truth(await this.eval(e.left, scope), e.left.pos) && this.truth(await this.eval(e.right, scope), e.right.pos);
    if (e.op === "or") return this.truth(await this.eval(e.left, scope), e.left.pos) || this.truth(await this.eval(e.right, scope), e.right.pos);
    const a = await this.eval(e.left, scope);
    const b = await this.eval(e.right, scope);
    switch (e.op) {
      case "==":
        return equals(a, b);
      case "!=":
        return !equals(a, b);
      case "+":
        if (typeof a === "string" || typeof b === "string") return this.checkText(display(a) + display(b), e.pos);
        return this.arith(a, b, e.pos, "+", (x, y) => x.plus(y));
      case "-":
        return this.arith(a, b, e.pos, "-", (x, y) => x.minus(y));
      case "*":
        return this.arith(a, b, e.pos, "*", (x, y) => x.times(y));
      case "/":
        return this.arith(a, b, e.pos, "/", (x, y) => {
          if (y.isZero()) throw new VekoError("Division by zero.", e.pos);
          return x.dividedBy(y);
        });
      case "%":
        return this.arith(a, b, e.pos, "%", (x, y) => {
          if (y.isZero()) throw new VekoError("Division by zero.", e.pos);
          return x.mod(y);
        });
      default: {
        const c = compare(a, b, e.pos);
        return e.op === "<" ? c < 0 : e.op === "<=" ? c <= 0 : e.op === ">" ? c > 0 : c >= 0;
      }
    }
  }

  private arith(a: Value, b: Value, pos: Pos, op: string, f: (x: Dec, y: Dec) => Dec): Dec {
    if (!isDec(a) || !isDec(b)) throw new VekoError(`Cannot use "${op}" with ${typeName(a)} and ${typeName(b)}.`, pos);
    return f(a, b);
  }

  // ----------------------------------------------------------------- calls

  private async invokeValue(callee: Value, args: Value[], named: Map<string, Value>, pos: Pos): Promise<Value> {
    if (callee instanceof VNative) return callee.fn(args, named, pos);
    if (callee && typeof callee === "object" && "kind" in callee && callee.kind === "function") return this.invoke(callee, args, named, pos);
    throw new VekoError(`${typeName(callee)} cannot be called.`, pos);
  }

  private async invoke(fn: FunctionDecl, args: Value[], named: Map<string, Value>, pos: Pos): Promise<Value> {
    if (args.length + named.size !== fn.params.length) {
      throw new VekoError(`${fn.name} expects ${fn.params.length} argument(s) but got ${args.length + named.size}.`, pos);
    }
    if (++this.depth > this.limits.maxDepth) throw new VekoError(`Too many nested calls (more than ${this.limits.maxDepth}).`, pos, "limit");
    const scope = new Scope(null);
    fn.params.forEach((p, i) => {
      if (i < args.length) scope.declare(p, args[i]!);
      else if (named.has(p)) scope.declare(p, named.get(p)!);
      else throw new VekoError(`${fn.name} is missing argument "${p}".`, pos);
    });
    // Functions do not see the caller's object; pass what they need as arguments.
    const savedSelf = this.self;
    const savedMembers = this.selfMembers;
    this.self = null;
    this.selfMembers = new Set();
    try {
      await this.block(fn.body, scope);
      return null;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      this.self = savedSelf;
      this.selfMembers = savedMembers;
      this.depth--;
    }
  }

  // -------------------------------------------------------------- builtins

  private requirePost(what: string, pos: Pos) {
    if (this.mode !== "post") throw new VekoError(`${what} can only be used while a document posts ("on post").`, pos);
  }

  private installBuiltins() {
    const g = this.globals;
    const host = this.host;
    const num = (v: Value, pos: Pos, what = "a number"): Dec => {
      if (!isDec(v)) throw new VekoError(`Expected ${what}, got ${typeName(v)}.`, pos);
      return v;
    };
    const ref = (v: Value, pos: Pos, kind: string): VRef => {
      if (!(v instanceof VRef) || (kind !== "*" && v.type !== kind)) throw new VekoError(`Expected ${kind === "*" ? "a reference" : `an ${kind}`}, got ${typeName(v)}.`, pos);
      return v;
    };
    const date = (v: Value, pos: Pos): VDate => {
      if (!(v instanceof VDate)) throw new VekoError(`Expected a date, got ${typeName(v)}.`, pos);
      return v;
    };
    const arity = (args: Value[], n: number, name: string, pos: Pos) => {
      if (args.length !== n) throw new VekoError(`${name} expects ${n} argument(s).`, pos);
    };

    g.set("today", new VNative("today", () => new VDate(host.today())));
    g.set(
      "toDate",
      new VNative("toDate", (args, _n, pos) => {
        arity(args, 1, "toDate", pos);
        const s = args[0];
        if (typeof s !== "string" || !ISO_DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
          throw new VekoError(`toDate needs text like "2026-10-28".`, pos);
        }
        return new VDate(s);
      }),
    );
    g.set(
      "addDays",
      new VNative("addDays", (args, _n, pos) => {
        arity(args, 2, "addDays", pos);
        const d = date(args[0]!, pos);
        const n = num(args[1]!, pos);
        if (!n.isInteger()) throw new VekoError("addDays needs a whole number of days.", pos);
        const t = new Date(`${d.iso}T00:00:00Z`);
        t.setUTCDate(t.getUTCDate() + n.toNumber());
        return new VDate(t.toISOString().slice(0, 10));
      }),
    );
    g.set(
      "daysBetween",
      new VNative("daysBetween", (args, _n, pos) => {
        arity(args, 2, "daysBetween", pos);
        const a = Date.parse(`${date(args[0]!, pos).iso}T00:00:00Z`);
        const b = Date.parse(`${date(args[1]!, pos).iso}T00:00:00Z`);
        return new D(Math.round((b - a) / 86_400_000));
      }),
    );
    g.set(
      "round",
      new VNative("round", (args, _n, pos) => {
        if (args.length < 1 || args.length > 2) throw new VekoError("round expects a number and optional places.", pos);
        const places = args.length === 2 ? num(args[1]!, pos).toNumber() : 0;
        if (!Number.isInteger(places) || places < 0 || places > 10) throw new VekoError("round places must be 0 to 10.", pos);
        return num(args[0]!, pos).toDecimalPlaces(places, D.ROUND_HALF_UP);
      }),
    );
    g.set("abs", new VNative("abs", (args, _n, pos) => (arity(args, 1, "abs", pos), num(args[0]!, pos).abs())));
    const extreme = (name: string, pick: (a: Dec, b: Dec) => boolean) =>
      new VNative(name, (args, _n, pos) => {
        const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        if (list.length === 0) throw new VekoError(`${name} needs at least one number.`, pos);
        return list.map((v) => num(v, pos)).reduce((a, b) => (pick(a, b) ? a : b));
      });
    g.set("min", extreme("min", (a, b) => a.lte(b)));
    g.set("max", extreme("max", (a, b) => a.gte(b)));
    g.set(
      "len",
      new VNative("len", (args, _n, pos) => {
        arity(args, 1, "len", pos);
        const v = args[0]!;
        if (typeof v === "string" || Array.isArray(v)) return new D(v.length);
        throw new VekoError(`len needs text or a list, got ${typeName(v)}.`, pos);
      }),
    );
    g.set("text", new VNative("text", (args, _n, pos) => (arity(args, 1, "text", pos), display(args[0]!))));
    g.set(
      "number",
      new VNative("number", (args, _n, pos) => {
        arity(args, 1, "number", pos);
        const v = args[0]!;
        if (isDec(v)) return v;
        if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return new D(v.trim());
        throw new VekoError(`Cannot turn ${show(v)} into a number.`, pos);
      }),
    );
    g.set("upper", new VNative("upper", (args, _n, pos) => (arity(args, 1, "upper", pos), String(display(args[0]!)).toUpperCase())));
    g.set("lower", new VNative("lower", (args, _n, pos) => (arity(args, 1, "lower", pos), String(display(args[0]!)).toLowerCase())));
    g.set(
      "message",
      new VNative("message", (args, _n, pos) => {
        arity(args, 1, "message", pos);
        host.message(this.checkText(display(args[0]!), pos));
        return null;
      }),
    );

    g.set(
      "ledger",
      new VHost("ledger", (name, pos) => {
        if (name !== "post") throw new VekoError(`ledger has no member "${name}".`, pos);
        return new VNative("ledger.post", async (args, named, p) => {
          this.requirePost("ledger.post", p);
          if (args.length) throw new VekoError("ledger.post takes named arguments: debit, credit, amount, party, memo.", p);
          for (const k of named.keys()) if (!["debit", "credit", "amount", "party", "memo"].includes(k)) throw new VekoError(`ledger.post has no argument "${k}".`, p);
          const amount = num(named.get("amount") ?? null, p, "an amount");
          const party = named.get("party") ?? null;
          const memo = named.get("memo") ?? null;
          await host.ledgerPost(
            {
              debit: ref(named.get("debit") ?? null, p, "Account"),
              credit: ref(named.get("credit") ?? null, p, "Account"),
              amount,
              party: party === null ? null : ref(party, p, "*"),
              memo: memo === null ? null : display(memo),
            },
            p,
          );
          return null;
        });
      }),
    );
    g.set(
      "stock",
      new VHost("stock", (name, pos) => {
        if (name === "receive") {
          return new VNative("stock.receive", async (args, named, p) => {
            this.requirePost("stock.receive", p);
            arity(args, 3, "stock.receive(item, quantity, cost, credit: account)", p);
            for (const k of named.keys()) if (k !== "credit") throw new VekoError(`stock.receive has no argument "${k}".`, p);
            if (!named.has("credit")) throw new VekoError("stock.receive needs credit: the account the stock is paid from, e.g. credit: accounts.cash.", p);
            await host.stockReceive(ref(args[0]!, p, "Item"), num(args[1]!, p), num(args[2]!, p), ref(named.get("credit")!, p, "Account"), p);
            return null;
          });
        }
        if (name === "issue") {
          return new VNative("stock.issue", async (args, named, p) => {
            this.requirePost("stock.issue", p);
            arity(args, 2, "stock.issue(item, quantity, debit: account)", p);
            for (const k of named.keys()) if (k !== "debit") throw new VekoError(`stock.issue has no argument "${k}".`, p);
            const debit = named.get("debit");
            return host.stockIssue(ref(args[0]!, p, "Item"), num(args[1]!, p), debit === undefined || debit === null ? null : ref(debit, p, "Account"), p);
          });
        }
        throw new VekoError(`stock has no member "${name}".`, pos);
      }),
    );
    g.set(
      "accounts",
      new VHost("accounts", (name, pos) => {
        if (name === "number") {
          return new VNative("accounts.number", (args, _n, p) => {
            arity(args, 1, "accounts.number", p);
            return host.accountByNumber(display(args[0]!), p);
          });
        }
        return host.account(name, pos);
      }),
    );

    for (const r of this.schema.registers.values()) {
      g.set(
        r.name,
        new VHost(r.name, (name, pos) => {
          if (name === "add" || name === "subtract") {
            return new VNative(`${r.name}.${name}`, async (_args, named, p) => {
              this.requirePost(`${r.name}.${name}`, p);
              await host.registerMove(r.name, name === "add" ? 1 : -1, named, p);
              return null;
            });
          }
          if (name === "balance") return new VNative(`${r.name}.balance`, (_a, named, p) => host.registerBalance(r.name, named, p));
          throw new VekoError(`Register ${r.name} has no member "${name}".`, pos);
        }),
      );
    }
    for (const t of [...this.schema.catalogs.keys(), ...this.schema.documents.keys()]) {
      g.set(
        t,
        new VHost(t, (name, pos) => {
          if (name !== "find") throw new VekoError(`${t} has no member "${name}". Use ${t}.find(field: value).`, pos);
          return new VNative(`${t}.find`, (_a, named, p) => host.find(t, named, p));
        }),
      );
    }
  }
}

export function equals(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (isDec(a) && isDec(b)) return a.equals(b);
  if (a instanceof VDate && b instanceof VDate) return a.iso === b.iso;
  if (a instanceof VRef && b instanceof VRef) return a.type === b.type && a.id === b.id;
  return a === b;
}

function compare(a: Value, b: Value, pos: Pos): number {
  if (isDec(a) && isDec(b)) return a.comparedTo(b);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof VDate && b instanceof VDate) return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0;
  throw new VekoError(`Cannot compare ${typeName(a)} with ${typeName(b)}.`, pos);
}

/** Text form used by "+" with text, text() and message(). */
export function display(v: Value): string {
  if (isDec(v)) return v.toFixed();
  return show(v);
}
