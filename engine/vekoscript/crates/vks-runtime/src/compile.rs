//! Semantic analysis and lowering. The parsed module is checked against the language rules and
//! the application's metadata, names are resolved to slots, functions, built-ins and platform
//! services, and the result is a compact tree the interpreter runs.
//!
//! Variables are dynamic, but where the analyzer knows what a value is (a handler's object,
//! a row of a declared row set, a reference field) it checks member names against metadata so
//! mistakes are reported before anything runs.

use crate::builtins::Builtin;
use crate::value::{Root, Value};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use vks_metadata::{FieldMeta, FieldType, MetadataModel, ObjectKind, RegisterType};
use vks_syntax::ast::{self, AssignOp, BinaryOp, Event, ExprKind, Item, Stmt, UnaryOp};
use vks_syntax::{Diagnostic, Kind, Span};

pub type Slot = u16;

#[derive(Debug)]
pub struct E {
    pub kind: Ex,
    pub span: Span,
}

#[derive(Debug)]
pub struct A {
    pub name: Option<Rc<str>>,
    pub value: E,
}

#[derive(Debug)]
pub enum Ex {
    Const(Value),
    Local(Slot),
    Func(u32),
    Builtin(Builtin),
    Root(Root),
    Manager(Root, Rc<str>),
    Array(Vec<E>),
    Map(Vec<(Rc<str>, E)>),
    Member(Box<E>, Rc<str>),
    Index(Box<E>, Box<E>),
    CallValue(Box<E>, Vec<A>),
    CallFunc(u32, Vec<A>),
    CallBuiltin(Builtin, Vec<A>),
    CallMethod(Box<E>, Rc<str>, Vec<A>),
    Neg(Box<E>),
    Not(Box<E>),
    Bin(BinaryOp, Box<E>, Box<E>),
    And(Box<E>, Box<E>),
    Or(Box<E>, Box<E>),
}

#[derive(Debug)]
pub struct S {
    pub kind: St,
    pub span: Span,
}

#[derive(Debug)]
pub enum St {
    Let(Slot, E),
    SetLocal(Slot, AssignOp, E),
    SetMember(E, Rc<str>, AssignOp, E),
    SetIndex(E, E, AssignOp, E),
    If(E, Vec<S>, Vec<S>),
    While(E, Vec<S>),
    For(Slot, E, Vec<S>),
    /// `for i in range(a)` / `range(a, b)` without building an array.
    ForRange(Slot, E, Option<E>, Vec<S>),
    Return(Option<E>),
    Break,
    Continue,
    Expr(E),
}

#[derive(Debug, Default)]
pub struct Body {
    pub slots: usize,
    pub stmts: Vec<S>,
}

#[derive(Debug)]
pub struct Function {
    pub name: Rc<str>,
    pub params: Vec<Rc<str>>,
    pub body: Body,
    pub span: Span,
}

#[derive(Debug)]
pub struct Handler {
    pub target: Rc<str>,
    pub kind: ObjectKind,
    pub event: Event,
    pub body: Body,
    pub span: Span,
}

/// A checked, ready-to-run application.
#[derive(Debug)]
pub struct Program {
    pub metadata: Rc<MetadataModel>,
    pub functions: Vec<Function>,
    pub handlers: Vec<Handler>,
    pub script: Option<Body>,
}

impl Program {
    pub fn function(&self, name: &str) -> Option<u32> {
        self.functions.iter().position(|f| &*f.name == name).map(|i| i as u32)
    }
    pub fn handler(&self, target: &str, event: Event) -> Option<&Handler> {
        self.handlers.iter().find(|h| &*h.target == target && h.event == event)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Allow top-level statements (scripts run from the command line and tests). Applications
    /// deployed to the platform contain only declarations, functions and handlers.
    pub allow_script: bool,
}

/// Members every catalog item exposes besides its declared fields.
pub const CATALOG_MEMBERS: &[&str] = &["id", "version", "deleted"];
/// Members every document exposes besides its declared fields and rows.
pub const DOCUMENT_MEMBERS: &[&str] = &["id", "version", "deleted", "number", "date", "status"];
pub const CONTEXT_MEMBERS: &[&str] = &["user", "organization", "application", "operation", "correlationId"];
pub const OBJECT_METHODS: &[&str] = &["save", "delete", "ref", "isNew"];
pub const DOCUMENT_METHODS: &[&str] = &["post", "reverse"];
pub const ROWS_METHODS: &[&str] = &["add", "count", "get", "remove", "clear", "sum", "first", "last", "isEmpty"];
pub const CATALOG_MANAGER_METHODS: &[&str] = &["create", "findById", "findBy", "findByCode", "list"];
pub const DOCUMENT_MANAGER_METHODS: &[&str] = &["create", "findById", "findByNumber", "list"];
pub const REGISTER_METHODS: &[&str] = &["increase", "decrease", "balance"];

#[derive(Debug, Clone, PartialEq)]
enum SType {
    Unknown,
    Obj(Rc<str>),
    Ref(Rc<str>),
    Rows(Rc<str>, usize),
    Row(Rc<str>, usize),
    Manager(Root, Rc<str>),
    Root(Root),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyKind {
    Script,
    Function,
    Handler(Event),
}

enum Resolved {
    Local(Slot, SType),
    Func(u32),
    Builtin(Builtin),
    Root(Root),
}

struct FnSig {
    index: u32,
    params: Vec<String>,
}

struct Cx<'m> {
    meta: &'m MetadataModel,
    fns: HashMap<String, FnSig>,
    diags: Vec<Diagnostic>,
    scopes: Vec<Vec<(Rc<str>, Slot, SType)>>,
    next_slot: usize,
    max_slots: usize,
    loop_depth: u32,
    reassigned: HashSet<String>,
    body_kind: BodyKind,
}

pub fn compile(src: &str, options: Options) -> (Option<Program>, Vec<Diagnostic>) {
    let parsed = vks_syntax::parse(src);
    let mut diags = parsed.diagnostics;
    let (meta, mut mdiags) = vks_metadata::build(&parsed.module);
    diags.append(&mut mdiags);
    let (program, mut sdiags) = analyze(&parsed.module, meta, options);
    diags.append(&mut sdiags);
    diags.sort_by_key(|d| (d.span.offset, d.code));
    if vks_syntax::has_errors(&diags) {
        (None, diags)
    } else {
        (Some(program), diags)
    }
}

/// Check and lower a parsed module against its metadata.
pub fn analyze(module: &ast::Module, meta: MetadataModel, options: Options) -> (Program, Vec<Diagnostic>) {
    let mut cx = Cx { meta: &meta, fns: HashMap::new(), diags: Vec::new(), scopes: Vec::new(), next_slot: 0, max_slots: 0, loop_depth: 0, reassigned: HashSet::new(), body_kind: BodyKind::Script };

    // Functions are visible everywhere, including before their declaration.
    let mut decls: Vec<&ast::FunctionDecl> = Vec::new();
    for item in &module.items {
        if let Item::Function(f) = item {
            if Builtin::from_name(&f.name).is_some() || Root::from_name(&f.name).is_some() {
                cx.error("VKS3006", format!("\"{}\" is a built-in name and cannot be used for a function.", f.name), f.span);
                continue;
            }
            if cx.fns.contains_key(&f.name) {
                cx.error("VKS3006", format!("Function \"{}\" is already declared.", f.name), f.span);
                continue;
            }
            let mut seen = HashSet::new();
            for p in &f.params {
                if !seen.insert(p.as_str()) {
                    cx.error("VKS3007", format!("Parameter \"{p}\" is declared twice in {}.", f.name), f.span);
                }
            }
            cx.fns.insert(f.name.clone(), FnSig { index: decls.len() as u32, params: f.params.clone() });
            decls.push(f);
        }
    }

    let mut functions = Vec::new();
    for f in &decls {
        cx.body_kind = BodyKind::Function;
        let params: Vec<(String, SType)> = f.params.iter().map(|p| (p.clone(), SType::Unknown)).collect();
        let body = cx.body(&params, &f.body);
        functions.push(Function { name: Rc::from(f.name.as_str()), params: f.params.iter().map(|p| Rc::from(p.as_str())).collect(), body, span: f.span });
    }

    let mut handlers: Vec<Handler> = Vec::new();
    for item in &module.items {
        let Item::Handler(h) = item else { continue };
        let Some(kind) = meta.object_kind(&h.target) else {
            let hint = if meta.register(&h.target).is_some() { " Registers have no events; documents post to them." } else { "" };
            cx.error("VKS3009", format!("\"{}\" is not a catalog or document of this application.{hint}", h.target), h.target_span);
            continue;
        };
        if kind == ObjectKind::Catalog && h.event.document_only() {
            cx.error("VKS3011", format!("{} is a document event; {} is a catalog.", h.event.name(), h.target), h.span);
            continue;
        }
        if handlers.iter().any(|x| *x.target == *h.target && x.event == h.event) {
            cx.error("VKS3013", format!("{}.{} already has a handler.", h.target, h.event.name()), h.span);
            continue;
        }
        cx.body_kind = BodyKind::Handler(h.event);
        let body = cx.body(&[(h.param.clone(), SType::Obj(Rc::from(h.target.as_str())))], &h.body);
        handlers.push(Handler { target: Rc::from(h.target.as_str()), kind, event: h.event, body, span: h.span });
    }

    let stmts: Vec<Stmt> = module
        .items
        .iter()
        .filter_map(|i| match i {
            Item::Stmt(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    let script = if stmts.is_empty() {
        None
    } else if options.allow_script {
        cx.body_kind = BodyKind::Script;
        Some(cx.body(&[], &stmts))
    } else {
        cx.error("VKS3019", "Applications contain declarations, functions and event handlers only; move statements into a function or handler.", stmts[0].span());
        None
    };

    let diags = std::mem::take(&mut cx.diags);
    drop(cx);
    (Program { metadata: Rc::new(meta), functions, handlers, script }, diags)
}

fn collect_reassigned(stmts: &[Stmt], out: &mut HashSet<String>) {
    for s in stmts {
        match s {
            Stmt::Assign { target, .. } => {
                if let ExprKind::Ident(n) = &target.kind {
                    out.insert(n.clone());
                }
            }
            Stmt::If { then, otherwise, .. } => {
                collect_reassigned(then, out);
                if let Some(o) = otherwise {
                    collect_reassigned(o, out);
                }
            }
            Stmt::While { body, .. } | Stmt::For { body, .. } => collect_reassigned(body, out),
            _ => {}
        }
    }
}

impl<'m> Cx<'m> {
    fn error(&mut self, code: &'static str, message: impl Into<String>, span: Span) {
        self.diags.push(Diagnostic::error(code, Kind::Semantic, message, span));
    }

    fn body(&mut self, params: &[(String, SType)], stmts: &[Stmt]) -> Body {
        self.scopes = vec![Vec::new()];
        self.next_slot = 0;
        self.max_slots = 0;
        self.loop_depth = 0;
        self.reassigned.clear();
        let mut reassigned = HashSet::new();
        collect_reassigned(stmts, &mut reassigned);
        self.reassigned = reassigned;
        for (p, t) in params {
            let t = if self.reassigned.contains(p) { SType::Unknown } else { t.clone() };
            self.declare(p, t, Span::default());
        }
        let stmts = self.stmts(stmts);
        self.scopes.clear();
        Body { slots: self.max_slots, stmts }
    }

    fn declare(&mut self, name: &str, t: SType, span: Span) -> Slot {
        if self.scopes.last().is_some_and(|s| s.iter().any(|(n, ..)| &**n == name)) {
            self.error("VKS3002", format!("\"{name}\" is already declared in this block."), span);
        }
        if self.next_slot >= Slot::MAX as usize {
            self.error("VKS3020", "Too many variables in one function.", span);
            return 0;
        }
        let slot = self.next_slot as Slot;
        self.next_slot += 1;
        self.max_slots = self.max_slots.max(self.next_slot);
        let t = if self.reassigned.contains(name) { SType::Unknown } else { t };
        if let Some(scope) = self.scopes.last_mut() {
            scope.push((Rc::from(name), slot, t));
        }
        slot
    }

    fn scoped<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        let saved = self.next_slot;
        self.scopes.push(Vec::new());
        let out = f(self);
        self.scopes.pop();
        self.next_slot = saved;
        out
    }

    fn resolve(&self, name: &str) -> Option<Resolved> {
        for scope in self.scopes.iter().rev() {
            if let Some((_, slot, t)) = scope.iter().rev().find(|(n, ..)| &**n == name) {
                return Some(Resolved::Local(*slot, t.clone()));
            }
        }
        if let Some(f) = self.fns.get(name) {
            return Some(Resolved::Func(f.index));
        }
        if let Some(b) = Builtin::from_name(name) {
            return Some(Resolved::Builtin(b));
        }
        Root::from_name(name).map(Resolved::Root)
    }

    fn stmts(&mut self, stmts: &[Stmt]) -> Vec<S> {
        stmts.iter().filter_map(|s| self.stmt(s)).collect()
    }

    fn block(&mut self, stmts: &[Stmt]) -> Vec<S> {
        self.scoped(|cx| cx.stmts(stmts))
    }

    fn stmt(&mut self, s: &Stmt) -> Option<S> {
        let span = s.span();
        let kind = match s {
            Stmt::Let { name, value, span } => {
                let (v, t) = self.expr(value);
                let slot = self.declare(name, t, *span);
                St::Let(slot, v)
            }
            Stmt::Assign { target, op, value, .. } => {
                let (v, _) = self.expr(value);
                match &target.kind {
                    ExprKind::Ident(name) => match self.resolve(name) {
                        Some(Resolved::Local(slot, _)) => St::SetLocal(slot, *op, v),
                        Some(_) => {
                            self.error("VKS3018", format!("\"{name}\" is a function or platform name; it cannot be assigned."), target.span);
                            return None;
                        }
                        None => {
                            self.error("VKS3003", format!("\"{name}\" is not declared; use let {name} = ...; first."), target.span);
                            return None;
                        }
                    },
                    ExprKind::Member { object, name } => {
                        let (o, t) = self.expr(object);
                        self.check_member(&t, name, true, target.span);
                        St::SetMember(o, Rc::from(name.as_str()), *op, v)
                    }
                    ExprKind::Index { object, index } => {
                        let (o, _) = self.expr(object);
                        let (i, _) = self.expr(index);
                        St::SetIndex(o, i, *op, v)
                    }
                    _ => {
                        self.error("VKS3004", "Only variables, fields and elements can be assigned.", target.span);
                        return None;
                    }
                }
            }
            Stmt::If { cond, then, otherwise, .. } => {
                let (c, _) = self.expr(cond);
                let t = self.block(then);
                let o = otherwise.as_ref().map(|o| self.block(o)).unwrap_or_default();
                St::If(c, t, o)
            }
            Stmt::While { cond, body, .. } => {
                let (c, _) = self.expr(cond);
                self.loop_depth += 1;
                let b = self.block(body);
                self.loop_depth -= 1;
                St::While(c, b)
            }
            Stmt::For { var, iter, body, span } => {
                let range = match &iter.kind {
                    ExprKind::Call { callee, args } => match &callee.kind {
                        ExprKind::Ident(n) if matches!(self.resolve(n), Some(Resolved::Builtin(Builtin::Range))) && (1..=2).contains(&args.len()) && args.iter().all(|a| a.name.is_none()) => {
                            Some(args)
                        }
                        _ => None,
                    },
                    _ => None,
                };
                let (it, t) = match range {
                    Some(args) => {
                        let a = self.expr(&args[0].value).0;
                        let b = args.get(1).map(|x| self.expr(&x.value).0);
                        (Err((a, b)), SType::Unknown)
                    }
                    None => {
                        let (e, t) = self.expr(iter);
                        (Ok(e), t)
                    }
                };
                let elem = match t {
                    SType::Rows(d, r) => SType::Row(d, r),
                    _ => SType::Unknown,
                };
                self.loop_depth += 1;
                let (slot, b) = self.scoped(|cx| {
                    let slot = cx.declare(var, elem, *span);
                    (slot, cx.stmts(body))
                });
                self.loop_depth -= 1;
                match it {
                    Ok(e) => St::For(slot, e, b),
                    Err((a, end)) => St::ForRange(slot, a, end, b),
                }
            }
            Stmt::Return { value, .. } => St::Return(value.as_ref().map(|v| self.expr(v).0)),
            Stmt::Break { span } | Stmt::Continue { span } => {
                if self.loop_depth == 0 {
                    let word = if matches!(s, Stmt::Break { .. }) { "break" } else { "continue" };
                    self.error("VKS3005", format!("{word} is only allowed inside a loop."), *span);
                    return None;
                }
                if matches!(s, Stmt::Break { .. }) {
                    St::Break
                } else {
                    St::Continue
                }
            }
            Stmt::Expr { expr, .. } => St::Expr(self.expr(expr).0),
        };
        Some(S { kind, span })
    }

    fn expr(&mut self, e: &ast::Expr) -> (E, SType) {
        let span = e.span;
        let (kind, t) = match &e.kind {
            ExprKind::Int(i) => (Ex::Const(Value::Int(*i)), SType::Unknown),
            ExprKind::Decimal(d) => (Ex::Const(Value::Dec(*d)), SType::Unknown),
            ExprKind::Str(s) => (Ex::Const(Value::Str(Rc::from(s.as_str()))), SType::Unknown),
            ExprKind::Bool(b) => (Ex::Const(Value::Bool(*b)), SType::Unknown),
            ExprKind::Null => (Ex::Const(Value::Null), SType::Unknown),
            ExprKind::Ident(name) => match self.resolve(name) {
                Some(Resolved::Local(slot, t)) => (Ex::Local(slot), t),
                Some(Resolved::Func(i)) => (Ex::Func(i), SType::Unknown),
                Some(Resolved::Builtin(b)) => (Ex::Builtin(b), SType::Unknown),
                Some(Resolved::Root(r)) => (Ex::Root(r), SType::Root(r)),
                None => {
                    self.error("VKS3001", format!("Unknown name \"{name}\"."), span);
                    (Ex::Const(Value::Null), SType::Unknown)
                }
            },
            ExprKind::Array(items) => (Ex::Array(items.iter().map(|i| self.expr(i).0).collect()), SType::Unknown),
            ExprKind::Map(entries) => (Ex::Map(entries.iter().map(|(k, v)| (Rc::from(k.as_str()), self.expr(v).0)).collect()), SType::Unknown),
            ExprKind::Member { object, name } => {
                let (o, ot) = self.expr(object);
                if let SType::Root(root @ (Root::Catalog | Root::Document | Root::Register)) = ot {
                    let exists = match root {
                        Root::Catalog => self.meta.catalog(name).is_some(),
                        Root::Document => self.meta.document(name).is_some(),
                        _ => self.meta.register(name).is_some(),
                    };
                    if !exists {
                        let what = match root {
                            Root::Catalog => "catalog",
                            Root::Document => "document",
                            _ => "register",
                        };
                        self.error("VKS3010", format!("This application has no {what} named \"{name}\"."), span);
                    }
                    let n: Rc<str> = Rc::from(name.as_str());
                    (Ex::Manager(root, n.clone()), SType::Manager(root, n))
                } else {
                    let t = self.check_member(&ot, name, false, span);
                    (Ex::Member(Box::new(o), Rc::from(name.as_str())), t)
                }
            }
            ExprKind::Index { object, index } => {
                let (o, _) = self.expr(object);
                let (i, _) = self.expr(index);
                (Ex::Index(Box::new(o), Box::new(i)), SType::Unknown)
            }
            ExprKind::Call { callee, args } => return self.call(callee, args, span),
            ExprKind::Unary { op, expr } => {
                let (x, _) = self.expr(expr);
                match op {
                    UnaryOp::Neg => (Ex::Neg(Box::new(x)), SType::Unknown),
                    UnaryOp::Not => (Ex::Not(Box::new(x)), SType::Unknown),
                }
            }
            ExprKind::Binary { op, left, right } => {
                let (l, _) = self.expr(left);
                let (r, _) = self.expr(right);
                let k = match op {
                    BinaryOp::And => Ex::And(Box::new(l), Box::new(r)),
                    BinaryOp::Or => Ex::Or(Box::new(l), Box::new(r)),
                    op => Ex::Bin(*op, Box::new(l), Box::new(r)),
                };
                (k, SType::Unknown)
            }
        };
        (E { kind, span }, t)
    }

    fn args(&mut self, args: &[ast::Arg]) -> Vec<A> {
        args.iter().map(|a| A { name: a.name.as_deref().map(Rc::from), value: self.expr(&a.value).0 }).collect()
    }

    fn call(&mut self, callee: &ast::Expr, args: &[ast::Arg], span: Span) -> (E, SType) {
        match &callee.kind {
            ExprKind::Ident(name) => match self.resolve(name) {
                Some(Resolved::Func(i)) => {
                    let params = self.fns.values().find(|f| f.index == i).map(|f| f.params.clone()).unwrap_or_default();
                    self.check_arity(name, &params, params.len(), false, args, span);
                    let a = self.args(args);
                    (E { kind: Ex::CallFunc(i, a), span }, SType::Unknown)
                }
                Some(Resolved::Builtin(b)) => {
                    let sig = b.signature();
                    let params: Vec<String> = sig.params.iter().map(|p| p.to_string()).collect();
                    self.check_arity(name, &params, sig.required, sig.variadic, args, span);
                    let a = self.args(args);
                    (E { kind: Ex::CallBuiltin(b, a), span }, SType::Unknown)
                }
                _ => {
                    let (c, _) = self.expr(callee);
                    let a = self.args(args);
                    (E { kind: Ex::CallValue(Box::new(c), a), span }, SType::Unknown)
                }
            },
            ExprKind::Member { object, name } => {
                let (o, ot) = self.expr(object);
                let t = self.check_method(&ot, name, args, span);
                let a = self.args(args);
                (E { kind: Ex::CallMethod(Box::new(o), Rc::from(name.as_str()), a), span }, t)
            }
            _ => {
                let (c, _) = self.expr(callee);
                let a = self.args(args);
                (E { kind: Ex::CallValue(Box::new(c), a), span }, SType::Unknown)
            }
        }
    }

    fn check_arity(&mut self, name: &str, params: &[String], required: usize, variadic: bool, args: &[ast::Arg], span: Span) {
        let positional = args.iter().filter(|a| a.name.is_none()).count();
        if positional > params.len() && !variadic {
            self.error("VKS3008", format!("{name} takes {} argument(s); {positional} given.", params.len()), span);
            return;
        }
        let mut given: Vec<&str> = params.iter().take(positional).map(String::as_str).collect();
        for a in args.iter().filter_map(|a| a.name.as_deref()) {
            if !params.iter().any(|p| p == a) {
                self.error("VKS3008", format!("{name} has no parameter named \"{a}\"."), span);
                return;
            }
            if given.contains(&a) {
                self.error("VKS3008", format!("Argument \"{a}\" of {name} is given twice."), span);
                return;
            }
            given.push(a);
        }
        if let Some(missing) = params.iter().take(required).find(|p| !given.contains(&p.as_str())) {
            self.error("VKS3008", format!("{name} needs the argument \"{missing}\"."), span);
        }
    }

    fn object_field(&self, type_name: &str, name: &str) -> Option<&'m FieldMeta> {
        self.meta.object_fields(type_name).and_then(|fs| fs.iter().find(|f| f.name == name))
    }

    fn field_stype(f: &FieldMeta) -> SType {
        match &f.ty {
            FieldType::Ref { target, .. } => SType::Ref(Rc::from(target.as_str())),
            _ => SType::Unknown,
        }
    }

    /// Check `value.name` (read, or assignment when `assigning`) where the analyzer knows what
    /// `value` is. Returns what `value.name` is when known.
    fn check_member(&mut self, t: &SType, name: &str, assigning: bool, span: Span) -> SType {
        match t {
            SType::Obj(ty) | SType::Ref(ty) => {
                let is_ref = matches!(t, SType::Ref(_));
                let kind = self.meta.object_kind(ty);
                if let Some(f) = self.object_field(ty, name) {
                    if assigning && is_ref {
                        self.error("VKS3017", format!("A reference to {ty} is read-only; load() it to change \"{name}\"."), span);
                    }
                    return Self::field_stype(f);
                }
                if let Some(doc) = self.meta.document(ty) {
                    if let Some(i) = doc.rows.iter().position(|r| r.name == name) {
                        if assigning {
                            self.error("VKS3017", format!("Rows \"{name}\" cannot be replaced; use add(), remove() and clear()."), span);
                        }
                        return SType::Rows(ty.clone(), i);
                    }
                }
                let system = if kind == Some(ObjectKind::Document) { DOCUMENT_MEMBERS } else { CATALOG_MEMBERS };
                if system.contains(&name) {
                    if assigning && !(name == "date" && !is_ref) {
                        self.error("VKS3017", format!("\"{name}\" is managed by the platform and cannot be assigned."), span);
                    }
                    return SType::Unknown;
                }
                self.error("VKS3012", format!("{ty} has no field \"{name}\"."), span);
                SType::Unknown
            }
            SType::Row(doc, i) => {
                let rows = &self.meta.document(doc).expect("row of known document").rows[*i];
                if let Some(f) = rows.fields.iter().find(|f| f.name == name) {
                    return Self::field_stype(f);
                }
                if name == "lineNo" {
                    if assigning {
                        self.error("VKS3017", "\"lineNo\" is managed by the platform and cannot be assigned.", span);
                    }
                    return SType::Unknown;
                }
                self.error("VKS3012", format!("Rows {}.{} have no field \"{name}\".", doc, rows.name), span);
                SType::Unknown
            }
            SType::Rows(doc, i) => {
                let rows = &self.meta.document(doc).expect("rows of known document").rows[*i].name;
                self.error("VKS3012", format!("Rows {doc}.{rows} have no field \"{name}\"; use a row, as in for row in ... {{ }}, or methods like count()."), span);
                SType::Unknown
            }
            SType::Manager(root, n) => {
                self.error("VKS3012", format!("{}.{} has no member \"{name}\"; call a method such as create().", root.name(), n), span);
                SType::Unknown
            }
            SType::Root(Root::Context) => {
                if !CONTEXT_MEMBERS.contains(&name) {
                    self.error("VKS3012", format!("Context has no member \"{name}\"."), span);
                } else if assigning {
                    self.error("VKS3017", "Context is read-only.", span);
                }
                SType::Unknown
            }
            _ => SType::Unknown,
        }
    }

    fn check_method(&mut self, t: &SType, name: &str, args: &[ast::Arg], span: Span) -> SType {
        let unknown = |cx: &mut Self, what: String| {
            cx.error("VKS3014", format!("{what} has no method \"{name}\"."), span);
            SType::Unknown
        };
        match t {
            SType::Manager(Root::Catalog, ty) => {
                if !CATALOG_MANAGER_METHODS.contains(&name) {
                    return unknown(self, format!("Catalog.{ty}"));
                }
                if name == "findByCode" && self.object_field(ty, "code").is_none() {
                    self.error("VKS3014", format!("Catalog {ty} has no \"code\" field, so findByCode is not available; use findBy(\"field\", value)."), span);
                }
                if name == "create" {
                    self.check_field_args(ty, args, span);
                }
                if name == "list" {
                    return SType::Unknown;
                }
                SType::Obj(ty.clone())
            }
            SType::Manager(Root::Document, ty) => {
                if !DOCUMENT_MANAGER_METHODS.contains(&name) {
                    return unknown(self, format!("Document.{ty}"));
                }
                if name == "create" {
                    self.check_field_args(ty, args, span);
                }
                if name == "list" {
                    return SType::Unknown;
                }
                SType::Obj(ty.clone())
            }
            SType::Manager(Root::Register, reg) => {
                if !REGISTER_METHODS.contains(&name) {
                    return unknown(self, format!("Register.{reg}"));
                }
                let Some(r) = self.meta.register(reg) else { return SType::Unknown };
                if name != "balance" {
                    if r.ty != RegisterType::Accumulation {
                        self.error("VKS3015", format!("{reg} is an information register; increase/decrease apply to accumulation registers."), span);
                    }
                    match self.body_kind {
                        BodyKind::Handler(Event::Post) | BodyKind::Function => {}
                        _ => self.error("VKS3016", format!("Register movements can only be made while posting, in a Post handler (\"{name}\" here)."), span),
                    }
                }
                let mut seen: Vec<&str> = Vec::new();
                for a in args {
                    let Some(n) = a.name.as_deref() else {
                        self.error("VKS3015", format!("Arguments of {reg}.{name} are named, as in product: item.product."), span);
                        return SType::Unknown;
                    };
                    let known = r.dimensions.iter().any(|d| d.name == n) || (name != "balance" && r.values.iter().any(|v| v.name == n)) || (name == "balance" && n == "at");
                    if !known {
                        self.error("VKS3015", format!("{reg}.{name} has no argument \"{n}\"."), span);
                    }
                    seen.push(n);
                }
                if name != "balance" {
                    for d in &r.dimensions {
                        if !seen.contains(&d.name.as_str()) {
                            self.error("VKS3015", format!("{reg}.{name} needs the dimension \"{}\".", d.name), span);
                        }
                    }
                }
                SType::Unknown
            }
            SType::Manager(Root::Context, _) => SType::Unknown,
            SType::Obj(ty) => {
                let doc = self.meta.document(ty).is_some();
                if OBJECT_METHODS.contains(&name) || (doc && DOCUMENT_METHODS.contains(&name)) {
                    if name == "ref" {
                        return SType::Ref(ty.clone());
                    }
                    return SType::Unknown;
                }
                unknown(self, ty.to_string())
            }
            SType::Ref(ty) => {
                if name == "load" {
                    return SType::Obj(ty.clone());
                }
                unknown(self, format!("A reference to {ty}"))
            }
            SType::Rows(doc, i) => {
                if !ROWS_METHODS.contains(&name) {
                    return unknown(self, format!("Rows of {doc}"));
                }
                let rows = self.meta.document(doc).expect("known document").rows[*i].clone();
                if name == "add" {
                    for a in args {
                        match a.name.as_deref() {
                            None => {
                                self.error("VKS3015", "Arguments of add() are named fields, as in add(product: p, quantity: 2).", span);
                                break;
                            }
                            Some(n) if !rows.fields.iter().any(|f| f.name == n) => {
                                self.error("VKS3012", format!("Rows {}.{} have no field \"{n}\".", doc, rows.name), span);
                            }
                            _ => {}
                        }
                    }
                }
                if name == "sum" {
                    if let Some(ExprKind::Str(f)) = args.first().map(|a| &a.value.kind) {
                        match rows.fields.iter().find(|x| &x.name == f) {
                            Some(x) if x.ty.is_numeric() => {}
                            Some(_) => self.error("VKS3015", format!("Field \"{f}\" is not numeric; sum() adds Decimal or Integer fields."), span),
                            None => self.error("VKS3012", format!("Rows {}.{} have no field \"{f}\".", doc, rows.name), span),
                        }
                    }
                }
                if matches!(name, "add" | "get" | "first" | "last") {
                    return SType::Row(doc.clone(), *i);
                }
                SType::Unknown
            }
            SType::Row(doc, _) => unknown(self, format!("A row of {doc}")),
            SType::Root(Root::Context) => {
                if name != "can" {
                    return unknown(self, "Context".into());
                }
                SType::Unknown
            }
            SType::Root(r) => unknown(self, r.name().to_string()),
            SType::Unknown => SType::Unknown,
        }
    }

    fn check_field_args(&mut self, ty: &str, args: &[ast::Arg], span: Span) {
        for a in args {
            match a.name.as_deref() {
                None => {
                    self.error("VKS3015", "Arguments of create() are named fields, as in create(code: \"P-1\").", span);
                    return;
                }
                Some(n) if self.object_field(ty, n).is_none() && !(n == "date" && self.meta.document(ty).is_some()) => {
                    self.error("VKS3012", format!("{ty} has no field \"{n}\"."), span);
                }
                _ => {}
            }
        }
    }
}
