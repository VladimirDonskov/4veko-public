//! Recursive-descent parser. On an error it records a diagnostic and resynchronizes at the
//! next `;`, `}` or declaration keyword, so one mistake does not hide the rest.

use crate::ast::*;
use crate::diagnostics::{Diagnostic, Kind, Span};
use crate::lexer::{tokenize, Tok, Token};
use rust_decimal::Decimal;
use std::str::FromStr;

/// Nesting limit for expressions and blocks, so hostile input cannot overflow the stack.
pub const MAX_NESTING: u32 = 100;

pub struct ParseResult {
    pub module: Module,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn parse(src: &str) -> ParseResult {
    let (tokens, mut diagnostics) = tokenize(src);
    let mut p = Parser { tokens, pos: 0, diags: Vec::new(), depth: 0 };
    let module = p.module();
    diagnostics.extend(p.diags);
    ParseResult { module, diagnostics }
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    diags: Vec<Diagnostic>,
    depth: u32,
}

#[derive(Debug)]
struct Bail;
type P<T> = Result<T, Bail>;

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos].tok
    }
    fn peek_at(&self, n: usize) -> &Tok {
        &self.tokens[(self.pos + n).min(self.tokens.len() - 1)].tok
    }
    fn span(&self) -> Span {
        self.tokens[self.pos].span
    }
    fn prev_span(&self) -> Span {
        self.tokens[self.pos.saturating_sub(1)].span
    }
    fn bump(&mut self) -> Token {
        let t = self.tokens[self.pos].clone();
        if t.tok != Tok::Eof {
            self.pos += 1;
        }
        t
    }
    fn at(&self, t: &Tok) -> bool {
        std::mem::discriminant(self.peek()) == std::mem::discriminant(t)
    }
    fn eat(&mut self, t: &Tok) -> bool {
        if self.at(t) {
            self.bump();
            true
        } else {
            false
        }
    }
    fn is_word(&self, w: &str) -> bool {
        matches!(self.peek(), Tok::Ident(s) if s == w)
    }
    fn word_at(&self, n: usize, w: &str) -> bool {
        matches!(self.peek_at(n), Tok::Ident(s) if s == w)
    }
    fn eat_word(&mut self, w: &str) -> bool {
        if self.is_word(w) {
            self.bump();
            true
        } else {
            false
        }
    }
    /// Contextual keywords start a declaration only when followed by a name ("catalog Products").
    fn at_declaration(&self) -> bool {
        let named = matches!(self.peek_at(1), Tok::Ident(_));
        ((self.is_word("catalog") || self.is_word("document") || self.is_word("register")) && named) || (self.is_word("information") && self.word_at(1, "register"))
    }
    fn error<T>(&mut self, code: &'static str, msg: impl Into<String>, span: Span) -> P<T> {
        self.diags.push(Diagnostic::error(code, Kind::Syntax, msg, span));
        Err(Bail)
    }
    fn expect(&mut self, t: &Tok, what: &str) -> P<Token> {
        if self.at(t) {
            return Ok(self.bump());
        }
        let found = self.peek().describe();
        let span = self.span();
        self.error("VKS1101", format!("Expected {what} but found {found}."), span)
    }
    fn ident(&mut self, what: &str) -> P<(String, Span)> {
        if let Tok::Ident(name) = self.peek().clone() {
            let t = self.bump();
            return Ok((name, t.span));
        }
        let found = self.peek().describe();
        let span = self.span();
        let hint = if crate::lexer::symbol(self.peek()) != "?" && !matches!(self.peek(), Tok::Eof) { " (it is a reserved word)" } else { "" };
        self.error("VKS1102", format!("Expected {what} but found {found}{hint}."), span)
    }
    fn enter(&mut self) -> P<()> {
        self.depth += 1;
        if self.depth > MAX_NESTING {
            let span = self.span();
            return self.error("VKS1199", "The code is nested too deeply.", span);
        }
        Ok(())
    }
    fn leave(&mut self) {
        self.depth -= 1;
    }

    /// Skip to a point where parsing can resume.
    fn sync(&mut self, stop_at_brace: bool) {
        let mut depth = 0i32;
        let mut moved = false;
        loop {
            match self.peek() {
                // The start of the next statement is a safe place to resume.
                Tok::Let | Tok::If | Tok::While | Tok::For | Tok::Return if depth == 0 && moved => return,
                Tok::Eof => return,
                Tok::Semi if depth == 0 => {
                    self.bump();
                    return;
                }
                Tok::LBrace => depth += 1,
                Tok::RBrace => {
                    if depth == 0 {
                        if !stop_at_brace {
                            self.bump();
                        }
                        return;
                    }
                    depth -= 1;
                }
                Tok::Function | Tok::On if depth == 0 && stop_at_brace => return,
                Tok::Ident(_) if depth == 0 && stop_at_brace && self.at_declaration() => return,
                _ => {}
            }
            self.bump();
            moved = true;
        }
    }

    fn module(&mut self) -> Module {
        let mut items = Vec::new();
        while !self.at(&Tok::Eof) {
            let before = self.pos;
            match self.item() {
                Ok(item) => items.push(item),
                Err(Bail) => {
                    self.sync(true);
                    if self.at(&Tok::RBrace) {
                        self.bump();
                    }
                }
            }
            if self.pos == before {
                self.bump();
            }
        }
        Module { items }
    }

    fn item(&mut self) -> P<Item> {
        if self.at_declaration() {
            return if self.is_word("catalog") {
                self.catalog().map(Item::Catalog)
            } else if self.is_word("document") {
                self.document().map(Item::Document)
            } else {
                self.register().map(Item::Register)
            };
        }
        match self.peek() {
            Tok::Function => self.function().map(Item::Function),
            Tok::On => self.handler().map(Item::Handler),
            _ => self.statement().map(Item::Stmt),
        }
    }

    // ------------------------------------------------------------- metadata

    fn type_ref(&mut self) -> P<(TypeRef, Span)> {
        let (name, span) = self.ident("a type such as String, Decimal(18, 2) or Ref<Products>")?;
        let int = |p: &mut Parser| -> P<u32> {
            match p.peek().clone() {
                Tok::Int(s) => {
                    let sp = p.bump().span;
                    s.parse::<u32>().or_else(|_| p.error("VKS1103", "This number is too large.", sp))
                }
                _ => {
                    let sp = p.span();
                    p.error("VKS1104", "Expected a whole number.", sp)
                }
            }
        };
        let ty = match name.as_str() {
            "String" => {
                if self.eat(&Tok::LParen) {
                    let n = int(self)?;
                    self.expect(&Tok::RParen, "\")\"")?;
                    TypeRef::String(Some(n))
                } else {
                    TypeRef::String(None)
                }
            }
            "Decimal" => {
                self.expect(&Tok::LParen, "\"(\" with precision and scale, as in Decimal(18, 2)")?;
                let p = int(self)?;
                self.expect(&Tok::Comma, "\",\"")?;
                let s = int(self)?;
                self.expect(&Tok::RParen, "\")\"")?;
                TypeRef::Decimal(p, s)
            }
            "Integer" => TypeRef::Integer,
            "Boolean" => TypeRef::Boolean,
            "Date" => TypeRef::Date,
            "DateTime" => TypeRef::DateTime,
            "Ref" => {
                self.expect(&Tok::Lt, "\"<\" as in Ref<Products>")?;
                let (target, _) = self.ident("the name of a catalog or document")?;
                self.expect(&Tok::Gt, "\">\"")?;
                TypeRef::Ref(target)
            }
            other => return self.error("VKS1105", format!("Unknown type \"{other}\". Use String, String(n), Decimal(p, s), Integer, Boolean, Date, DateTime or Ref<Name>."), span),
        };
        Ok((ty, span.to(self.prev_span())))
    }

    fn literal(&mut self) -> P<Literal> {
        let neg = self.eat(&Tok::Minus);
        let span = self.span();
        let lit = match self.peek().clone() {
            Tok::Int(s) => {
                self.bump();
                let v: i64 = match s.parse() {
                    Ok(v) => v,
                    Err(_) => return self.error("VKS1103", "This integer is too large.", span),
                };
                Literal::Int(if neg { -v } else { v })
            }
            Tok::Decimal(s) => {
                self.bump();
                let d = match Decimal::from_str(&s) {
                    Ok(d) => d,
                    Err(_) => return self.error("VKS1103", "This decimal is too large.", span),
                };
                Literal::Decimal(if neg { -d } else { d })
            }
            Tok::Str(s) if !neg => {
                self.bump();
                Literal::Str(s)
            }
            Tok::True if !neg => {
                self.bump();
                Literal::Bool(true)
            }
            Tok::False if !neg => {
                self.bump();
                Literal::Bool(false)
            }
            Tok::Null if !neg => {
                self.bump();
                Literal::Null
            }
            _ => return self.error("VKS1106", "Expected a literal value after \"default\".", span),
        };
        Ok(lit)
    }

    fn field(&mut self) -> P<FieldDecl> {
        let start = self.bump().span;
        let (name, _) = self.ident("a name")?;
        self.expect(&Tok::Colon, "\":\" and a type")?;
        let (ty, ty_span) = self.type_ref()?;
        let mut f = FieldDecl { name, ty, ty_span, required: false, unique: false, default: None, span: start };
        loop {
            if self.eat_word("required") {
                f.required = true;
            } else if self.eat_word("unique") {
                f.unique = true;
            } else if self.eat_word("default") {
                f.default = Some(self.literal()?);
            } else {
                break;
            }
        }
        self.expect(&Tok::Semi, "\";\" after the declaration")?;
        f.span = start.to(self.prev_span());
        Ok(f)
    }

    /// Parse members inside `{ ... }`, recovering per member.
    fn members<F>(&mut self, mut each: F) -> P<()>
    where
        F: FnMut(&mut Parser) -> P<()>,
    {
        self.expect(&Tok::LBrace, "\"{\"")?;
        while !self.at(&Tok::RBrace) && !self.at(&Tok::Eof) {
            let before = self.pos;
            if each(self).is_err() {
                self.sync(true);
            }
            if self.pos == before {
                self.bump();
            }
        }
        self.expect(&Tok::RBrace, "\"}\"")?;
        Ok(())
    }

    fn catalog(&mut self) -> P<CatalogDecl> {
        let start = self.bump().span;
        let (name, _) = self.ident("a catalog name")?;
        let mut fields = Vec::new();
        self.members(|p| {
            if p.is_word("field") {
                fields.push(p.field()?);
                Ok(())
            } else {
                let (found, sp) = (p.peek().describe(), p.span());
                p.error("VKS1107", format!("Inside a catalog, expected \"field\" but found {found}."), sp)
            }
        })?;
        Ok(CatalogDecl { name, fields, span: start.to(self.prev_span()) })
    }

    fn document(&mut self) -> P<DocumentDecl> {
        let start = self.bump().span;
        let (name, _) = self.ident("a document name")?;
        let mut fields = Vec::new();
        let mut rows = Vec::new();
        self.members(|p| match p.peek() {
            _ if p.is_word("field") => {
                fields.push(p.field()?);
                Ok(())
            }
            _ if p.is_word("rows") => {
                let rs = p.bump().span;
                let (rname, _) = p.ident("a name for the rows")?;
                let mut rfields = Vec::new();
                p.members(|q| {
                    if q.is_word("field") {
                        rfields.push(q.field()?);
                        Ok(())
                    } else {
                        let (found, sp) = (q.peek().describe(), q.span());
                        q.error("VKS1107", format!("Inside rows, expected \"field\" but found {found}."), sp)
                    }
                })?;
                rows.push(RowsDecl { name: rname, fields: rfields, span: rs.to(p.prev_span()) });
                Ok(())
            }
            _ => {
                let (found, sp) = (p.peek().describe(), p.span());
                p.error("VKS1107", format!("Inside a document, expected \"field\" or \"rows\" but found {found}."), sp)
            }
        })?;
        Ok(DocumentDecl { name, fields, rows, span: start.to(self.prev_span()) })
    }

    fn register(&mut self) -> P<RegisterDecl> {
        let start = self.span();
        let information = self.eat_word("information");
        if !self.eat_word("register") {
            let (found, sp) = (self.peek().describe(), self.span());
            return self.error("VKS1101", format!("Expected \"register\" but found {found}."), sp);
        }
        let (name, _) = self.ident("a register name")?;
        let periodic = self.eat_word("periodic");
        if periodic && !information {
            let sp = self.prev_span();
            return self.error("VKS1108", "Only information registers can be periodic; accumulation registers are always dated.", sp);
        }
        let kind = if information { RegisterKind::Information { periodic } } else { RegisterKind::Accumulation };
        let mut dimensions = Vec::new();
        let mut values = Vec::new();
        self.members(|p| match p.peek() {
            _ if p.is_word("dimension") => {
                dimensions.push(p.field()?);
                Ok(())
            }
            _ if !information && p.is_word("measure") => {
                values.push(p.field()?);
                Ok(())
            }
            _ if information && p.is_word("resource") => {
                values.push(p.field()?);
                Ok(())
            }
            _ => {
                let expected = if information { "\"dimension\" or \"resource\"" } else { "\"dimension\" or \"measure\"" };
                let (found, sp) = (p.peek().describe(), p.span());
                p.error("VKS1107", format!("Inside this register, expected {expected} but found {found}."), sp)
            }
        })?;
        Ok(RegisterDecl { name, kind, dimensions, values, span: start.to(self.prev_span()) })
    }

    // ---------------------------------------------------------------- logic

    fn function(&mut self) -> P<FunctionDecl> {
        let start = self.bump().span;
        let (name, _) = self.ident("a function name")?;
        self.expect(&Tok::LParen, "\"(\"")?;
        let mut params = Vec::new();
        if !self.at(&Tok::RParen) {
            loop {
                params.push(self.ident("a parameter name")?.0);
                if !self.eat(&Tok::Comma) {
                    break;
                }
            }
        }
        self.expect(&Tok::RParen, "\")\"")?;
        let body = self.block()?;
        Ok(FunctionDecl { name, params, body, span: start.to(self.prev_span()) })
    }

    fn handler(&mut self) -> P<HandlerDecl> {
        let start = self.bump().span;
        let (target, target_span) = self.ident("a catalog or document name, as in on GoodsReceipt.BeforePost(document)")?;
        self.expect(&Tok::Dot, "\".\" and an event name")?;
        let (event_name, ev_span) = self.ident("an event name such as BeforeSave or Post")?;
        let Some(event) = Event::parse(&event_name) else {
            let names: Vec<&str> = Event::ALL.iter().map(|e| e.name()).collect();
            return self.error("VKS1109", format!("Unknown event \"{event_name}\". Events: {}.", names.join(", ")), ev_span);
        };
        self.expect(&Tok::LParen, "\"(\" and a parameter name")?;
        let (param, _) = self.ident("a parameter name for the object")?;
        self.expect(&Tok::RParen, "\")\"")?;
        let body = self.block()?;
        Ok(HandlerDecl { target, target_span, event, param, body, span: start.to(self.prev_span()) })
    }

    fn block(&mut self) -> P<Vec<Stmt>> {
        self.enter()?;
        self.expect(&Tok::LBrace, "\"{\" to start a block")?;
        let mut out = Vec::new();
        while !self.at(&Tok::RBrace) && !self.at(&Tok::Eof) {
            let before = self.pos;
            match self.statement() {
                Ok(s) => out.push(s),
                Err(Bail) => self.sync(true),
            }
            if self.pos == before {
                self.bump();
            }
        }
        let r = self.expect(&Tok::RBrace, "\"}\" to close the block");
        self.leave();
        r?;
        Ok(out)
    }

    fn statement(&mut self) -> P<Stmt> {
        let start = self.span();
        match self.peek() {
            Tok::Let => {
                self.bump();
                let (name, _) = self.ident("a variable name")?;
                self.expect(&Tok::Assign, "\"=\"")?;
                let value = self.expr(false)?;
                self.expect(&Tok::Semi, "\";\"")?;
                Ok(Stmt::Let { name, value, span: start.to(self.prev_span()) })
            }
            Tok::If => self.if_stmt(),
            Tok::While => {
                self.bump();
                let cond = self.expr(true)?;
                let body = self.block()?;
                Ok(Stmt::While { cond, body, span: start.to(self.prev_span()) })
            }
            Tok::For => {
                self.bump();
                let (var, _) = self.ident("a loop variable")?;
                self.expect(&Tok::In, "\"in\"")?;
                let iter = self.expr(true)?;
                let body = self.block()?;
                Ok(Stmt::For { var, iter, body, span: start.to(self.prev_span()) })
            }
            Tok::Return => {
                self.bump();
                let value = if self.at(&Tok::Semi) { None } else { Some(self.expr(false)?) };
                self.expect(&Tok::Semi, "\";\"")?;
                Ok(Stmt::Return { value, span: start.to(self.prev_span()) })
            }
            Tok::Break => {
                self.bump();
                self.expect(&Tok::Semi, "\";\"")?;
                Ok(Stmt::Break { span: start })
            }
            Tok::Continue => {
                self.bump();
                self.expect(&Tok::Semi, "\";\"")?;
                Ok(Stmt::Continue { span: start })
            }
            Tok::LBrace => self.error("VKS1110", "A statement cannot start with \"{\". Blocks belong to if, while, for, functions and handlers.", start),
            Tok::Function | Tok::On => self.error("VKS1111", "Declarations are only allowed at the top level, not inside blocks.", start),
            Tok::Ident(_) if self.at_declaration() => self.error("VKS1111", "Declarations are only allowed at the top level, not inside blocks.", start),
            _ => {
                let expr = self.expr(false)?;
                let op = match self.peek() {
                    Tok::Assign => Some(AssignOp::Set),
                    Tok::PlusAssign => Some(AssignOp::Add),
                    Tok::MinusAssign => Some(AssignOp::Sub),
                    _ => None,
                };
                if let Some(op) = op {
                    if !matches!(expr.kind, ExprKind::Ident(_) | ExprKind::Member { .. } | ExprKind::Index { .. }) {
                        return self.error("VKS1112", "Only variables, properties and elements can be assigned.", expr.span);
                    }
                    self.bump();
                    let value = self.expr(false)?;
                    self.expect(&Tok::Semi, "\";\"")?;
                    return Ok(Stmt::Assign { target: expr, op, value, span: start.to(self.prev_span()) });
                }
                self.expect(&Tok::Semi, "\";\" after the statement")?;
                Ok(Stmt::Expr { expr, span: start.to(self.prev_span()) })
            }
        }
    }

    fn if_stmt(&mut self) -> P<Stmt> {
        let start = self.bump().span;
        let cond = self.expr(true)?;
        let then = self.block()?;
        let otherwise = if self.eat(&Tok::Else) {
            if self.at(&Tok::If) {
                Some(vec![self.if_stmt()?])
            } else {
                Some(self.block()?)
            }
        } else {
            None
        };
        Ok(Stmt::If { cond, then, otherwise, span: start.to(self.prev_span()) })
    }

    // ---------------------------------------------------------- expressions

    /// `no_map`: in if/while/for headers a "{" starts the block, never a map literal.
    fn expr(&mut self, no_map: bool) -> P<Expr> {
        self.enter()?;
        let r = self.or(no_map);
        self.leave();
        r
    }

    /// Binary operator and its precedence (higher binds tighter); all are left-associative.
    fn binary_op(&self) -> Option<(BinaryOp, u8)> {
        Some(match self.peek() {
            Tok::OrOr => (BinaryOp::Or, 1),
            Tok::AndAnd => (BinaryOp::And, 2),
            Tok::Eq => (BinaryOp::Eq, 3),
            Tok::NotEq => (BinaryOp::NotEq, 3),
            Tok::Lt => (BinaryOp::Lt, 4),
            Tok::LtEq => (BinaryOp::LtEq, 4),
            Tok::Gt => (BinaryOp::Gt, 4),
            Tok::GtEq => (BinaryOp::GtEq, 4),
            Tok::Plus => (BinaryOp::Add, 5),
            Tok::Minus => (BinaryOp::Sub, 5),
            Tok::Star => (BinaryOp::Mul, 6),
            Tok::Slash => (BinaryOp::Div, 6),
            Tok::Percent => (BinaryOp::Rem, 6),
            _ => return None,
        })
    }

    /// Precedence climbing: one stack frame per nesting level instead of one per precedence
    /// level, so deeply nested input cannot exhaust the stack before the nesting limit applies.
    fn climb(&mut self, no_map: bool, min_prec: u8) -> P<Expr> {
        let mut left = self.unary(no_map)?;
        while let Some((op, prec)) = self.binary_op() {
            if prec < min_prec {
                break;
            }
            self.bump();
            let right = self.climb(no_map, prec + 1)?;
            let span = left.span.to(right.span);
            left = Expr { kind: ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) }, span };
        }
        Ok(left)
    }

    fn or(&mut self, no_map: bool) -> P<Expr> {
        self.climb(no_map, 1)
    }

    fn unary(&mut self, no_map: bool) -> P<Expr> {
        let start = self.span();
        let op = match self.peek() {
            Tok::Bang => UnaryOp::Not,
            Tok::Minus => UnaryOp::Neg,
            _ => return self.postfix(no_map),
        };
        self.bump();
        // -9223372036854775808 is the one integer that only fits when negated.
        if op == UnaryOp::Neg {
            if let Tok::Int(s) = self.peek().clone() {
                if s.parse::<i64>().is_err() {
                    if let Ok(v) = format!("-{s}").parse::<i64>() {
                        let sp = self.bump().span;
                        return Ok(Expr { kind: ExprKind::Int(v), span: start.to(sp) });
                    }
                }
            }
        }
        self.enter()?;
        let inner = self.unary(no_map);
        self.leave();
        let inner = inner?;
        // Fold "-literal" so -9223372036854775808 and decimal literals are exact.
        if op == UnaryOp::Neg {
            match &inner.kind {
                ExprKind::Decimal(d) => return Ok(Expr { kind: ExprKind::Decimal(-*d), span: start.to(inner.span) }),
                ExprKind::Int(i) => return Ok(Expr { kind: ExprKind::Int(-*i), span: start.to(inner.span) }),
                _ => {}
            }
        }
        let span = start.to(inner.span);
        Ok(Expr { kind: ExprKind::Unary { op, expr: Box::new(inner) }, span })
    }

    fn postfix(&mut self, no_map: bool) -> P<Expr> {
        let mut e = self.primary(no_map)?;
        loop {
            match self.peek() {
                Tok::Dot => {
                    self.bump();
                    let (name, nspan) = match self.peek().clone() {
                        Tok::Ident(n) => (n, self.bump().span),
                        // Keywords are allowed as member names (record.default, x.in…).
                        t if crate::lexer::symbol(&t).chars().all(|c| c.is_ascii_alphabetic()) => {
                            let sp = self.bump().span;
                            (crate::lexer::symbol(&t).to_string(), sp)
                        }
                        _ => {
                            let sp = self.span();
                            return self.error("VKS1113", "Expected a property or method name after \".\".", sp);
                        }
                    };
                    let span = e.span.to(nspan);
                    e = Expr { kind: ExprKind::Member { object: Box::new(e), name }, span };
                }
                Tok::LBracket => {
                    self.bump();
                    let index = self.expr(false)?;
                    self.expect(&Tok::RBracket, "\"]\"")?;
                    let span = e.span.to(self.prev_span());
                    e = Expr { kind: ExprKind::Index { object: Box::new(e), index: Box::new(index) }, span };
                }
                Tok::LParen => {
                    self.bump();
                    let mut args: Vec<Arg> = Vec::new();
                    if !self.at(&Tok::RParen) {
                        loop {
                            let named = matches!(self.peek(), Tok::Ident(_)) && matches!(self.peek_at(1), Tok::Colon);
                            if named {
                                let (n, nsp) = self.ident("an argument name")?;
                                self.bump();
                                if args.iter().any(|a| a.name.as_deref() == Some(n.as_str())) {
                                    return self.error("VKS1114", format!("Argument \"{n}\" is given twice."), nsp);
                                }
                                args.push(Arg { name: Some(n), value: self.expr(false)? });
                            } else {
                                if args.iter().any(|a| a.name.is_some()) {
                                    let sp = self.span();
                                    return self.error("VKS1115", "Positional arguments must come before named arguments.", sp);
                                }
                                args.push(Arg { name: None, value: self.expr(false)? });
                            }
                            if !self.eat(&Tok::Comma) {
                                break;
                            }
                            if self.at(&Tok::RParen) {
                                break; // trailing comma
                            }
                        }
                    }
                    self.expect(&Tok::RParen, "\")\" to close the call")?;
                    let span = e.span.to(self.prev_span());
                    e = Expr { kind: ExprKind::Call { callee: Box::new(e), args }, span };
                }
                _ => return Ok(e),
            }
        }
    }

    fn primary(&mut self, no_map: bool) -> P<Expr> {
        let span = self.span();
        let kind = match self.peek().clone() {
            Tok::Int(s) => {
                self.bump();
                match s.parse::<i64>() {
                    Ok(v) => ExprKind::Int(v),
                    // 9223372036854775808 only exists negated; keep it as a decimal otherwise.
                    Err(_) => match Decimal::from_str(&s) {
                        Ok(d) => ExprKind::Decimal(d),
                        Err(_) => return self.error("VKS1103", "This number is too large.", span),
                    },
                }
            }
            Tok::Decimal(s) => {
                self.bump();
                match Decimal::from_str(&s) {
                    Ok(d) => ExprKind::Decimal(d),
                    Err(_) => return self.error("VKS1103", "This decimal has more than 28 significant digits.", span),
                }
            }
            Tok::Str(s) => {
                self.bump();
                ExprKind::Str(s)
            }
            Tok::True => {
                self.bump();
                ExprKind::Bool(true)
            }
            Tok::False => {
                self.bump();
                ExprKind::Bool(false)
            }
            Tok::Null => {
                self.bump();
                ExprKind::Null
            }
            Tok::Ident(name) => {
                self.bump();
                ExprKind::Ident(name)
            }
            Tok::LParen => {
                self.bump();
                let e = self.expr(false)?;
                self.expect(&Tok::RParen, "\")\"")?;
                return Ok(Expr { kind: e.kind, span: span.to(self.prev_span()) });
            }
            Tok::LBracket => {
                self.bump();
                let mut items = Vec::new();
                if !self.at(&Tok::RBracket) {
                    loop {
                        items.push(self.expr(false)?);
                        if !self.eat(&Tok::Comma) || self.at(&Tok::RBracket) {
                            break;
                        }
                    }
                }
                self.expect(&Tok::RBracket, "\"]\"")?;
                ExprKind::Array(items)
            }
            Tok::LBrace if !no_map => {
                self.bump();
                let mut entries: Vec<(String, Expr)> = Vec::new();
                if !self.at(&Tok::RBrace) {
                    loop {
                        let key = match self.peek().clone() {
                            Tok::Ident(k) | Tok::Str(k) => {
                                self.bump();
                                k
                            }
                            _ => {
                                let sp = self.span();
                                return self.error("VKS1116", "Expected a key (name or string) in the map.", sp);
                            }
                        };
                        self.expect(&Tok::Colon, "\":\" after the key")?;
                        if entries.iter().any(|(k, _)| *k == key) {
                            return self.error("VKS1117", format!("Key \"{key}\" appears twice."), self.prev_span());
                        }
                        entries.push((key, self.expr(false)?));
                        if !self.eat(&Tok::Comma) || self.at(&Tok::RBrace) {
                            break;
                        }
                    }
                }
                self.expect(&Tok::RBrace, "\"}\" to close the map")?;
                ExprKind::Map(entries)
            }
            other => return self.error("VKS1118", format!("Expected a value but found {}.", other.describe()), span),
        };
        Ok(Expr { kind, span: span.to(self.prev_span()) })
    }
}
