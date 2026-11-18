import { VekoError, type Pos } from "./ast";

export const KEYWORDS = new Set([
  "catalog",
  "document",
  "register",
  "function",
  "field",
  "table",
  "dimension",
  "resource",
  "required",
  "nonnegative",
  "on",
  "end",
  "let",
  "if",
  "elif",
  "else",
  "for",
  "in",
  "while",
  "return",
  "fail",
  "break",
  "continue",
  "and",
  "or",
  "not",
  "true",
  "false",
  "null",
  "this",
]);

export type TokenKind = "ident" | "keyword" | "number" | "string" | "op" | "eof";

export type Token = {
  kind: TokenKind;
  value: string;
  pos: Pos;
  /** True when a line break separates this token from the previous one. */
  newlineBefore: boolean;
};

const OPERATORS = ["==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", "."];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let newline = true;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") {
      newline = true;
      advance();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }
    const pos = { line, col };
    const push = (kind: TokenKind, value: string) => {
      tokens.push({ kind, value, pos, newlineBefore: newline });
      newline = false;
    };

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      if (source[j] === "." && /[0-9]/.test(source[j + 1] ?? "")) {
        j++;
        while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      }
      if (/[A-Za-z_]/.test(source[j] ?? "")) throw new VekoError(`Unexpected character "${source[j]}" in a number.`, { line, col: col + (j - i) }, "syntax");
      const text = source.slice(i, j);
      advance(j - i);
      push("number", text);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      const word = source.slice(i, j);
      advance(j - i);
      push(KEYWORDS.has(word) ? "keyword" : "ident", word);
      continue;
    }
    if (ch === '"') {
      advance();
      let out = "";
      for (;;) {
        if (i >= source.length || source[i] === "\n") throw new VekoError("Text is missing its closing quote.", pos, "syntax");
        const c = source[i]!;
        if (c === '"') {
          advance();
          break;
        }
        if (c === "\\") {
          const next = source[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
          if (next === undefined || !(next in map)) throw new VekoError(`Unknown escape "\\${next ?? ""}".`, { line, col }, "syntax");
          out += map[next];
          advance(2);
          continue;
        }
        out += c;
        advance();
      }
      push("string", out);
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      advance(op.length);
      push("op", op);
      continue;
    }
    throw new VekoError(`Unexpected character "${ch}".`, pos, "syntax");
  }
  tokens.push({ kind: "eof", value: "", pos: { line, col }, newlineBefore: true });
  return tokens;
}
