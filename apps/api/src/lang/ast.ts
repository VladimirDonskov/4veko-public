// Syntax tree for the Veko language. Every node carries its source position.

export type Pos = { line: number; col: number };

export class VekoError extends Error {
  constructor(
    message: string,
    public readonly pos: Pos | null,
    public readonly kind: "syntax" | "check" | "runtime" | "fail" | "limit" = "runtime",
  ) {
    super(message);
  }
  /** "Line 4, column 7: message" for people. */
  describe() {
    return this.pos ? `Line ${this.pos.line}, column ${this.pos.col}: ${this.message}` : this.message;
  }
}

export type FieldType = { name: string; pos: Pos };

export type FieldDecl = { name: string; type: FieldType; required: boolean; pos: Pos };
export type TableDecl = { name: string; columns: FieldDecl[]; pos: Pos };
export type Handler = { event: "write" | "post"; body: Stmt[]; pos: Pos };

export type CatalogDecl = { kind: "catalog"; name: string; fields: FieldDecl[]; handlers: Handler[]; pos: Pos };
export type DocumentDecl = {
  kind: "document";
  name: string;
  fields: FieldDecl[];
  tables: TableDecl[];
  handlers: Handler[];
  pos: Pos;
};
export type RegisterDecl = {
  kind: "register";
  name: string;
  nonnegative: boolean;
  dimensions: FieldDecl[];
  resources: FieldDecl[];
  pos: Pos;
};
export type FunctionDecl = { kind: "function"; name: string; params: string[]; body: Stmt[]; pos: Pos };
export type Decl = CatalogDecl | DocumentDecl | RegisterDecl | FunctionDecl;
export type Program = { decls: Decl[] };

export type Stmt =
  | { kind: "let"; name: string; value: Expr; pos: Pos }
  | { kind: "assign"; target: Expr; value: Expr; pos: Pos }
  | { kind: "if"; branches: { cond: Expr; body: Stmt[] }[]; otherwise: Stmt[] | null; pos: Pos }
  | { kind: "for"; name: string; iterable: Expr; body: Stmt[]; pos: Pos }
  | { kind: "while"; cond: Expr; body: Stmt[]; pos: Pos }
  | { kind: "return"; value: Expr | null; pos: Pos }
  | { kind: "fail"; message: Expr; pos: Pos }
  | { kind: "break"; pos: Pos }
  | { kind: "continue"; pos: Pos }
  | { kind: "expr"; expr: Expr; pos: Pos };

export type Expr =
  | { kind: "number"; value: string; pos: Pos }
  | { kind: "string"; value: string; pos: Pos }
  | { kind: "bool"; value: boolean; pos: Pos }
  | { kind: "null"; pos: Pos }
  | { kind: "name"; name: string; pos: Pos }
  | { kind: "this"; pos: Pos }
  | { kind: "list"; items: Expr[]; pos: Pos }
  | { kind: "record"; entries: { key: string; value: Expr }[]; pos: Pos }
  | { kind: "member"; object: Expr; name: string; pos: Pos }
  | { kind: "index"; object: Expr; index: Expr; pos: Pos }
  | { kind: "call"; callee: Expr; args: Expr[]; named: { name: string; value: Expr }[]; pos: Pos }
  | { kind: "unary"; op: "-" | "not"; operand: Expr; pos: Pos }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; pos: Pos };

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
