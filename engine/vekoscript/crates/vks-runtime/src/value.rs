//! Runtime values. Scalars are immutable; arrays, maps, business objects and rows are shared,
//! mutable cells (assigning one to another variable shares it, as in most scripting languages).

use chrono::{NaiveDate, NaiveDateTime};
use rust_decimal::Decimal;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::rc::{Rc, Weak};
use vks_metadata::ObjectKind;

use crate::builtins::Builtin;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Root {
    Catalog,
    Document,
    Register,
    Context,
}

impl Root {
    pub fn name(self) -> &'static str {
        match self {
            Root::Catalog => "Catalog",
            Root::Document => "Document",
            Root::Register => "Register",
            Root::Context => "Context",
        }
    }
    pub fn from_name(n: &str) -> Option<Root> {
        Some(match n {
            "Catalog" => Root::Catalog,
            "Document" => Root::Document,
            "Register" => Root::Register,
            "Context" => Root::Context,
            _ => return None,
        })
    }
}

/// Identifies a catalog item or document: type and id.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RefVal {
    pub kind: ObjectKind,
    pub type_name: Rc<str>,
    pub id: Rc<str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Draft,
    Posted,
    Reversed,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Status::Draft => "draft",
            Status::Posted => "posted",
            Status::Reversed => "reversed",
        }
    }
    pub fn parse(s: &str) -> Option<Status> {
        Some(match s {
            "draft" => Status::Draft,
            "posted" => Status::Posted,
            "reversed" => Status::Reversed,
            _ => return None,
        })
    }
}

/// A catalog item or document held by the script. Fields are aligned with the metadata.
#[derive(Debug)]
pub struct Obj {
    pub kind: ObjectKind,
    pub type_name: Rc<str>,
    pub id: Option<Rc<str>>,
    pub version: Option<i64>,
    pub number: Option<Rc<str>>,
    pub date: Option<NaiveDate>,
    pub status: Option<Status>,
    pub deleted: bool,
    pub fields: Vec<Value>,
    /// One table per declared row set (documents only), aligned with the metadata.
    pub rows: Vec<Vec<Rc<RefCell<RowData>>>>,
    pub lock: Option<Lock>,
}

/// Restrictions on an object the script did not load itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lock {
    /// Fields and rows may change (BeforeCreate and BeforeSave handlers).
    pub writable: bool,
    pub reason: LockReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    /// The object an event handler is running for. It cannot be saved, posted or deleted
    /// from inside its own handler.
    Handler(vks_syntax::ast::Event),
    /// Data read through a reference (`receipt.supplier.name`); load() gives an editable copy.
    Reference,
}

#[derive(Debug)]
pub struct RowData {
    pub doc_type: Rc<str>,
    pub rows_index: usize,
    pub line_no: u32,
    pub fields: Vec<Value>,
    /// The document the row belongs to (weak: rows do not keep their document alive).
    pub parent: Weak<RefCell<Obj>>,
}

/// An insertion-ordered map with string keys. Small maps search linearly; large ones keep an
/// index.
#[derive(Debug, Default, Clone)]
pub struct OrderedMap {
    entries: Vec<(Rc<str>, Value)>,
    index: Option<HashMap<Rc<str>, usize>>,
}

const INDEX_THRESHOLD: usize = 16;

impl OrderedMap {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    fn position(&self, key: &str) -> Option<usize> {
        match &self.index {
            Some(ix) => ix.get(key).copied(),
            None => self.entries.iter().position(|(k, _)| &**k == key),
        }
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.position(key).map(|i| &self.entries[i].1)
    }
    pub fn contains(&self, key: &str) -> bool {
        self.position(key).is_some()
    }
    /// Returns true when the key is new.
    pub fn insert(&mut self, key: Rc<str>, value: Value) -> bool {
        if let Some(i) = self.position(&key) {
            self.entries[i].1 = value;
            return false;
        }
        self.entries.push((key.clone(), value));
        match &mut self.index {
            Some(ix) => {
                ix.insert(key, self.entries.len() - 1);
            }
            None if self.entries.len() > INDEX_THRESHOLD => {
                self.index = Some(self.entries.iter().enumerate().map(|(i, (k, _))| (k.clone(), i)).collect());
            }
            None => {}
        }
        true
    }
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.position(key)?;
        let (_, v) = self.entries.remove(i);
        if self.index.is_some() {
            self.index = Some(self.entries.iter().enumerate().map(|(i, (k, _))| (k.clone(), i)).collect());
        }
        Some(v)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(Rc<str>, Value)> {
        self.entries.iter()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FuncVal {
    User(u32),
    Builtin(Builtin),
}

/// Platform entry points reachable from scripts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Service {
    Root(Root),
    /// `Catalog.Products`, `Document.GoodsReceipt`, `Register.StockBalance`.
    Manager(Root, Rc<str>),
}

#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Dec(Decimal),
    Str(Rc<str>),
    Date(NaiveDate),
    /// UTC, whole seconds.
    DateTime(NaiveDateTime),
    /// Whole seconds.
    Duration(i64),
    Money(Decimal, Rc<str>),
    Array(Rc<RefCell<Vec<Value>>>),
    Map(Rc<RefCell<OrderedMap>>),
    Ref(Rc<RefVal>),
    Object(Rc<RefCell<Obj>>),
    /// A document's row table, viewed through its document.
    Rows(Rc<RefCell<Obj>>, usize),
    Row(Rc<RefCell<RowData>>),
    Func(FuncVal),
    Service(Service),
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::Str(Rc::from(s))
    }
    pub fn array(items: Vec<Value>) -> Value {
        Value::Array(Rc::new(RefCell::new(items)))
    }
    pub fn map(m: OrderedMap) -> Value {
        Value::Map(Rc::new(RefCell::new(m)))
    }

    /// The name `typeOf` returns.
    pub fn type_name(&self) -> String {
        match self {
            Value::Null => "Null".into(),
            Value::Bool(_) => "Boolean".into(),
            Value::Int(_) => "Integer".into(),
            Value::Dec(_) => "Decimal".into(),
            Value::Str(_) => "String".into(),
            Value::Date(_) => "Date".into(),
            Value::DateTime(_) => "DateTime".into(),
            Value::Duration(_) => "Duration".into(),
            Value::Money(..) => "Money".into(),
            Value::Array(_) => "Array".into(),
            Value::Map(_) => "Map".into(),
            Value::Ref(r) => format!("Ref<{}>", r.type_name),
            Value::Object(o) => o.borrow().type_name.to_string(),
            Value::Rows(o, _) => format!("Rows<{}>", o.borrow().type_name),
            Value::Row(r) => format!("Row<{}>", r.borrow().doc_type),
            Value::Func(_) => "Function".into(),
            Value::Service(Service::Root(r)) => r.name().into(),
            Value::Service(Service::Manager(r, n)) => format!("{}.{}", r.name(), n),
        }
    }

    /// The general kind used in messages ("Cannot add String and Integer").
    pub fn kind_name(&self) -> &'static str {
        match self {
            Value::Null => "Null",
            Value::Bool(_) => "Boolean",
            Value::Int(_) => "Integer",
            Value::Dec(_) => "Decimal",
            Value::Str(_) => "String",
            Value::Date(_) => "Date",
            Value::DateTime(_) => "DateTime",
            Value::Duration(_) => "Duration",
            Value::Money(..) => "Money",
            Value::Array(_) => "Array",
            Value::Map(_) => "Map",
            Value::Ref(_) => "BusinessReference",
            Value::Object(_) => "BusinessObject",
            Value::Rows(..) | Value::Row(_) => "PlatformCollection",
            Value::Func(_) => "Function",
            Value::Service(_) => "Platform",
        }
    }

    /// Language equality: never fails. Integer and Decimal compare numerically; unrelated
    /// types are unequal; collections and objects compare by identity; references by type and id.
    pub fn equals(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Int(a), Value::Int(b)) => a == b,
            (Value::Int(a), Value::Dec(b)) | (Value::Dec(b), Value::Int(a)) => Decimal::from(*a) == *b,
            (Value::Dec(a), Value::Dec(b)) => a == b,
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Date(a), Value::Date(b)) => a == b,
            (Value::DateTime(a), Value::DateTime(b)) => a == b,
            (Value::Duration(a), Value::Duration(b)) => a == b,
            (Value::Money(a, c), Value::Money(b, d)) => a == b && c == d,
            (Value::Array(a), Value::Array(b)) => Rc::ptr_eq(a, b),
            (Value::Map(a), Value::Map(b)) => Rc::ptr_eq(a, b),
            (Value::Ref(a), Value::Ref(b)) => a.type_name == b.type_name && a.id == b.id,
            (Value::Ref(r), Value::Object(o)) | (Value::Object(o), Value::Ref(r)) => {
                let o = o.borrow();
                o.type_name == r.type_name && o.id.as_deref() == Some(&*r.id)
            }
            (Value::Object(a), Value::Object(b)) => {
                if Rc::ptr_eq(a, b) {
                    return true;
                }
                let (a, b) = (a.borrow(), b.borrow());
                a.type_name == b.type_name && a.id.is_some() && a.id == b.id
            }
            (Value::Rows(a, i), Value::Rows(b, j)) => Rc::ptr_eq(a, b) && i == j,
            (Value::Row(a), Value::Row(b)) => Rc::ptr_eq(a, b),
            (Value::Func(a), Value::Func(b)) => a == b,
            (Value::Service(a), Value::Service(b)) => a == b,
            _ => false,
        }
    }

    /// Text for `str(x)`, string formatting and messages.
    pub fn display(&self) -> String {
        let mut out = String::new();
        self.write_display(&mut out, 0);
        out
    }

    fn write_display(&self, out: &mut String, depth: usize) {
        if depth > 8 {
            out.push('…');
            return;
        }
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Int(i) => {
                let _ = write!(out, "{i}");
            }
            Value::Dec(d) => {
                let _ = write!(out, "{d}");
            }
            Value::Str(s) => out.push_str(s),
            Value::Date(d) => {
                let _ = write!(out, "{}", d.format("%Y-%m-%d"));
            }
            Value::DateTime(d) => {
                let _ = write!(out, "{}", d.format("%Y-%m-%dT%H:%M:%SZ"));
            }
            Value::Duration(s) => out.push_str(&format_duration(*s)),
            Value::Money(a, c) => {
                let _ = write!(out, "{a} {c}");
            }
            Value::Array(a) => {
                out.push('[');
                for (i, v) in a.borrow().iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    v.write_quoted(out, depth + 1);
                }
                out.push(']');
            }
            Value::Map(m) => {
                out.push('{');
                for (i, (k, v)) in m.borrow().iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(k);
                    out.push_str(": ");
                    v.write_quoted(out, depth + 1);
                }
                out.push('}');
            }
            Value::Ref(r) => {
                let _ = write!(out, "{}({})", r.type_name, r.id);
            }
            Value::Object(o) => {
                let o = o.borrow();
                match (&o.number, &o.id) {
                    (Some(n), _) => {
                        let _ = write!(out, "{} {}", o.type_name, n);
                    }
                    (None, Some(id)) => {
                        let _ = write!(out, "{}({})", o.type_name, id);
                    }
                    (None, None) => {
                        let _ = write!(out, "{}(new)", o.type_name);
                    }
                }
            }
            Value::Rows(o, _) => {
                let _ = write!(out, "rows of {}", o.borrow().type_name);
            }
            Value::Row(r) => {
                let _ = write!(out, "{} row {}", r.borrow().doc_type, r.borrow().line_no);
            }
            Value::Func(FuncVal::Builtin(b)) => {
                let _ = write!(out, "function {}", b.name());
            }
            Value::Func(FuncVal::User(i)) => {
                let _ = write!(out, "function #{i}");
            }
            Value::Service(_) => out.push_str(&self.type_name()),
        }
    }

    fn write_quoted(&self, out: &mut String, depth: usize) {
        if let Value::Str(s) = self {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    c => out.push(c),
                }
            }
            out.push('"');
        } else {
            self.write_display(out, depth);
        }
    }
}

pub fn format_duration(total: i64) -> String {
    if total == 0 {
        return "0s".into();
    }
    let sign = if total < 0 { "-" } else { "" };
    let mut s = total.unsigned_abs();
    let days = s / 86_400;
    s %= 86_400;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if h > 0 {
        parts.push(format!("{h}h"));
    }
    if m > 0 {
        parts.push(format!("{m}m"));
    }
    if sec > 0 {
        parts.push(format!("{sec}s"));
    }
    format!("{sign}{}", parts.join(" "))
}
