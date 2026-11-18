import {
  VekoError,
  type BinaryOp,
  type CatalogDecl,
  type Decl,
  type DocumentDecl,
  type Expr,
  type FieldDecl,
  type FunctionDecl,
  type Handler,
  type Program,
  type RegisterDecl,
  type Stmt,
  type TableDecl,
} from "./ast";
import { tokenize, type Token } from "./lexer";

/** Parse Veko source into a syntax tree. Throws VekoError (kind "syntax") with a position. */
export function parse(source: string): Program {
  return new Parser(tokenize(source)).program();
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private get tok(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    const t = this.tokens[this.i]!;
    if (t.kind !== "eof") this.i++;
    return t;
  }
  private is(value: string, kind?: Token["kind"]) {
    return this.tok.value === value && (kind ? this.tok.kind === kind : this.tok.kind === "keyword" || this.tok.kind === "op");
  }
  private accept(value: string) {
    if (this.is(value)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(value: string, what?: string): Token {
    if (!this.is(value)) throw this.error(`Expected ${what ?? `"${value}"`} but found ${this.describe(this.tok)}.`);
    return this.next();
  }
  private ident(what: string): Token {
    if (this.tok.kind !== "ident") {
      const hint = this.tok.kind === "keyword" ? ` ("${this.tok.value}" is a reserved word)` : "";
      throw this.error(`Expected ${what} but found ${this.describe(this.tok)}${hint}.`);
    }
    return this.next();
  }
  private describe(t: Token) {
    if (t.kind === "eof") return "the end of the code";
    if (t.kind === "string") return "text";
    return `"${t.value}"`;
  }
  private error(message: string, at = this.tok) {
    return new VekoError(message, at.pos, "syntax");
  }

  program(): Program {
    const decls: Decl[] = [];
    while (this.tok.kind !== "eof") decls.push(this.decl());
    return { decls };
  }

  private decl(): Decl {
    if (this.is("catalog")) return this.catalog();
    if (this.is("document")) return this.document();
    if (this.is("register")) return this.register();
    if (this.is("function")) return this.func();
    throw this.error(`Expected "catalog", "document", "register" or "function" but found ${this.describe(this.tok)}.`);
  }

  private fieldDecl(name: Token): FieldDecl {
    this.expect(":", 'a ":" and a type');
    const type = this.ident("a type such as Text, Money or Customer");
    const required = this.accept("required");
    return { name: name.value, type: { name: type.value, pos: type.pos }, required, pos: name.pos };
  }

  private catalog(): CatalogDecl {
    const start = this.next();
    const name = this.ident("a catalog name");
    const fields: FieldDecl[] = [];
    const handlers: Handler[] = [];
    while (!this.is("end")) {
      if (this.accept("field")) fields.push(this.fieldDecl(this.ident("a field name")));
      else if (this.is("on")) handlers.push(this.handler(["write"]));
      else throw this.error(`Inside a catalog, expected "field", "on" or "end" but found ${this.describe(this.tok)}.`);
    }
    this.expect("end");
    return { kind: "catalog", name: name.value, fields, handlers, pos: start.pos };
  }

  private document(): DocumentDecl {
    const start = this.next();
    const name = this.ident("a document name");
    const fields: FieldDecl[] = [];
    const tables: TableDecl[] = [];
    const handlers: Handler[] = [];
    while (!this.is("end")) {
      if (this.accept("field")) fields.push(this.fieldDecl(this.ident("a field name")));
      else if (this.is("table")) {
        const t = this.next();
        const tname = this.ident("a table name");
        const columns: FieldDecl[] = [];
        while (!this.is("end")) columns.push(this.fieldDecl(this.ident("a column name or end")));
        this.expect("end");
        tables.push({ name: tname.value, columns, pos: t.pos });
      } else if (this.is("on")) handlers.push(this.handler(["write", "post"]));
      else throw this.error(`Inside a document, expected "field", "table", "on" or "end" but found ${this.describe(this.tok)}.`);
    }
    this.expect("end");
    return { kind: "document", name: name.value, fields, tables, handlers, pos: start.pos };
  }

  private handler(allowed: ("write" | "post")[]): Handler {
    const on = this.next();
    const ev = this.tok;
    if (ev.kind !== "ident" || !allowed.includes(ev.value as "write")) {
      throw this.error(`Expected ${allowed.map((a) => `"${a}"`).join(" or ")} after "on".`);
    }
    this.next();
    const body = this.block();
    this.expect("end", '"end" to close the handler');
    return { event: ev.value as "write" | "post", body, pos: on.pos };
  }

  private register(): RegisterDecl {
    const start = this.next();
    const name = this.ident("a register name");
    const nonnegative = this.accept("nonnegative");
    const dimensions: FieldDecl[] = [];
    const resources: FieldDecl[] = [];
    while (!this.is("end")) {
      if (this.accept("dimension")) dimensions.push(this.fieldDecl(this.ident("a dimension name")));
      else if (this.accept("resource")) resources.push(this.fieldDecl(this.ident("a resource name")));
      else throw this.error(`Inside a register, expected "dimension", "resource" or "end" but found ${this.describe(this.tok)}.`);
    }
    this.expect("end");
    return { kind: "register", name: name.value, nonnegative, dimensions, resources, pos: start.pos };
  }

  private func(): FunctionDecl {
    const start = this.next();
    const name = this.ident("a function name");
    this.expect("(");
    const params: string[] = [];
    if (!this.is(")")) {
      do params.push(this.ident("a parameter name").value);
      while (this.accept(","));
    }
    this.expect(")");
    const body = this.block();
    this.expect("end", '"end" to close the function');
    return { kind: "function", name: name.value, params, body, pos: start.pos };
  }

  /** Statements until one of: end, elif, else, eof. */
  private block(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.is("end") && !this.is("elif") && !this.is("else") && this.tok.kind !== "eof") out.push(this.statement());
    return out;
  }

  private statement(): Stmt {
    const t = this.tok;
    if (this.accept("let")) {
      const name = this.ident("a variable name");
      this.expect("=");
      return { kind: "let", name: name.value, value: this.expr(), pos: t.pos };
    }
    if (this.accept("if")) {
      const branches = [{ cond: this.expr(), body: this.block() }];
      let otherwise: Stmt[] | null = null;
      for (;;) {
        if (this.accept("elif")) branches.push({ cond: this.expr(), body: this.block() });
        else if (this.accept("else")) {
          otherwise = this.block();
          break;
        } else break;
      }
      this.expect("end", '"end" to close the if');
      return { kind: "if", branches, otherwise, pos: t.pos };
    }
    if (this.accept("for")) {
      const name = this.ident("a loop variable");
      this.expect("in");
      const iterable = this.expr();
      const body = this.block();
      this.expect("end", '"end" to close the for loop');
      return { kind: "for", name: name.value, iterable, body, pos: t.pos };
    }
    if (this.accept("while")) {
      const cond = this.expr();
      const body = this.block();
      this.expect("end", '"end" to close the while loop');
      return { kind: "while", cond, body, pos: t.pos };
    }
    if (this.accept("return")) {
      const hasValue = !this.tok.newlineBefore && !this.is("end") && !this.is("else") && !this.is("elif") && this.tok.kind !== "eof";
      return { kind: "return", value: hasValue ? this.expr() : null, pos: t.pos };
    }
    if (this.accept("fail")) return { kind: "fail", message: this.expr(), pos: t.pos };
    if (this.accept("break")) return { kind: "break", pos: t.pos };
    if (this.accept("continue")) return { kind: "continue", pos: t.pos };
    if (this.tok.kind === "keyword" && !["this", "true", "false", "null", "not"].includes(this.tok.value)) {
      throw this.error(`Unexpected ${this.describe(this.tok)}.`);
    }

    const expr = this.expr();
    if (this.accept("=")) {
      if (expr.kind !== "name" && expr.kind !== "member" && expr.kind !== "index") {
        throw this.error("Only variables, fields and list items can be assigned.", t);
      }
      return { kind: "assign", target: expr, value: this.expr(), pos: t.pos };
    }
    return { kind: "expr", expr, pos: t.pos };
  }

  expr(): Expr {
    return this.or();
  }
  private or(): Expr {
    let left = this.and();
    while (this.is("or")) {
      const t = this.next();
      left = { kind: "binary", op: "or", left, right: this.and(), pos: t.pos };
    }
    return left;
  }
  private and(): Expr {
    let left = this.not();
    while (this.is("and")) {
      const t = this.next();
      left = { kind: "binary", op: "and", left, right: this.not(), pos: t.pos };
    }
    return left;
  }
  private not(): Expr {
    if (this.is("not")) {
      const t = this.next();
      return { kind: "unary", op: "not", operand: this.not(), pos: t.pos };
    }
    return this.comparison();
  }
  private comparison(): Expr {
    let left = this.additive();
    while (["==", "!=", "<", "<=", ">", ">="].some((o) => this.is(o, "op"))) {
      const t = this.next();
      left = { kind: "binary", op: t.value as BinaryOp, left, right: this.additive(), pos: t.pos };
    }
    return left;
  }
  private additive(): Expr {
    let left = this.multiplicative();
    while (this.is("+", "op") || this.is("-", "op")) {
      const t = this.next();
      left = { kind: "binary", op: t.value as BinaryOp, left, right: this.multiplicative(), pos: t.pos };
    }
    return left;
  }
  private multiplicative(): Expr {
    let left = this.unary();
    while (this.is("*", "op") || this.is("/", "op") || this.is("%", "op")) {
      const t = this.next();
      left = { kind: "binary", op: t.value as BinaryOp, left, right: this.unary(), pos: t.pos };
    }
    return left;
  }
  private unary(): Expr {
    if (this.is("-", "op")) {
      const t = this.next();
      return { kind: "unary", op: "-", operand: this.unary(), pos: t.pos };
    }
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.is(".", "op")) {
        const t = this.next();
        const name = this.tok;
        if (name.kind !== "ident" && name.kind !== "keyword") throw this.error("Expected a name after \".\".");
        this.next();
        e = { kind: "member", object: e, name: name.value, pos: t.pos };
      } else if (this.is("(", "op") && !this.tok.newlineBefore) {
        const t = this.next();
        const args: Expr[] = [];
        const named: { name: string; value: Expr }[] = [];
        if (!this.is(")")) {
          do {
            if (this.tok.kind === "ident" && this.tokens[this.i + 1]?.value === ":") {
              const n = this.next().value;
              this.next();
              if (named.some((x) => x.name === n)) throw this.error(`Argument "${n}" is given twice.`);
              named.push({ name: n, value: this.expr() });
            } else {
              if (named.length) throw this.error("Positional arguments must come before named ones.");
              args.push(this.expr());
            }
          } while (this.accept(","));
        }
        this.expect(")", '")" to close the call');
        e = { kind: "call", callee: e, args, named, pos: t.pos };
      } else if (this.is("[", "op") && !this.tok.newlineBefore) {
        const t = this.next();
        const index = this.expr();
        this.expect("]");
        e = { kind: "index", object: e, index, pos: t.pos };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.tok;
    switch (t.kind) {
      case "number":
        this.next();
        return { kind: "number", value: t.value, pos: t.pos };
      case "string":
        this.next();
        return { kind: "string", value: t.value, pos: t.pos };
      case "ident":
        this.next();
        return { kind: "name", name: t.value, pos: t.pos };
      case "keyword":
        if (t.value === "true" || t.value === "false") {
          this.next();
          return { kind: "bool", value: t.value === "true", pos: t.pos };
        }
        if (t.value === "null") {
          this.next();
          return { kind: "null", pos: t.pos };
        }
        if (t.value === "this") {
          this.next();
          return { kind: "this", pos: t.pos };
        }
        break;
      case "op":
        if (t.value === "(") {
          this.next();
          const e = this.expr();
          this.expect(")");
          return e;
        }
        if (t.value === "[") {
          this.next();
          const items: Expr[] = [];
          if (!this.is("]")) {
            do items.push(this.expr());
            while (this.accept(","));
          }
          this.expect("]");
          return { kind: "list", items, pos: t.pos };
        }
        if (t.value === "{") {
          this.next();
          const entries: { key: string; value: Expr }[] = [];
          if (!this.is("}")) {
            do {
              const k = this.ident("a field name");
              this.expect(":");
              entries.push({ key: k.value, value: this.expr() });
            } while (this.accept(","));
          }
          this.expect("}");
          return { kind: "record", entries, pos: t.pos };
        }
        break;
    }
    throw this.error(`Expected a value but found ${this.describe(t)}.`);
  }
}
