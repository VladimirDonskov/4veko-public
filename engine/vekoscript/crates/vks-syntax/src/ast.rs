//! Syntax tree for VekoScript. Metadata declarations and logic share one tree; the metadata
//! crate turns declarations into a validated model, the runtime executes functions,
//! handlers and top-level statements.

use crate::diagnostics::Span;
use rust_decimal::Decimal;

#[derive(Debug, Clone, PartialEq)]
pub struct Module {
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Catalog(CatalogDecl),
    Document(DocumentDecl),
    Register(RegisterDecl),
    Function(FunctionDecl),
    Handler(HandlerDecl),
    Stmt(Stmt),
}

#[derive(Debug, Clone, PartialEq)]
pub enum TypeRef {
    String(Option<u32>),
    Decimal(u32, u32),
    Integer,
    Boolean,
    Date,
    DateTime,
    Ref(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Int(i64),
    Decimal(Decimal),
    Str(String),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FieldDecl {
    pub name: String,
    pub ty: TypeRef,
    pub ty_span: Span,
    pub required: bool,
    pub unique: bool,
    pub default: Option<Literal>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CatalogDecl {
    pub name: String,
    pub fields: Vec<FieldDecl>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowsDecl {
    pub name: String,
    pub fields: Vec<FieldDecl>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentDecl {
    pub name: String,
    pub fields: Vec<FieldDecl>,
    pub rows: Vec<RowsDecl>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterKind {
    Accumulation,
    Information { periodic: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegisterDecl {
    pub name: String,
    pub kind: RegisterKind,
    pub dimensions: Vec<FieldDecl>,
    /// Measures for accumulation registers, resources for information registers.
    pub values: Vec<FieldDecl>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FunctionDecl {
    pub name: String,
    pub params: Vec<String>,
    pub body: Vec<Stmt>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Event {
    BeforeCreate,
    AfterCreate,
    BeforeSave,
    AfterSave,
    BeforePost,
    Post,
    AfterPost,
    BeforeReverse,
    AfterReverse,
    BeforeDelete,
    AfterDelete,
}

impl Event {
    pub const ALL: [Event; 11] = [
        Event::BeforeCreate,
        Event::AfterCreate,
        Event::BeforeSave,
        Event::AfterSave,
        Event::BeforePost,
        Event::Post,
        Event::AfterPost,
        Event::BeforeReverse,
        Event::AfterReverse,
        Event::BeforeDelete,
        Event::AfterDelete,
    ];
    pub fn parse(name: &str) -> Option<Event> {
        Event::ALL.into_iter().find(|e| e.name() == name)
    }
    pub fn name(self) -> &'static str {
        match self {
            Event::BeforeCreate => "BeforeCreate",
            Event::AfterCreate => "AfterCreate",
            Event::BeforeSave => "BeforeSave",
            Event::AfterSave => "AfterSave",
            Event::BeforePost => "BeforePost",
            Event::Post => "Post",
            Event::AfterPost => "AfterPost",
            Event::BeforeReverse => "BeforeReverse",
            Event::AfterReverse => "AfterReverse",
            Event::BeforeDelete => "BeforeDelete",
            Event::AfterDelete => "AfterDelete",
        }
    }
    /// Events that only documents have.
    pub fn document_only(self) -> bool {
        matches!(self, Event::BeforePost | Event::Post | Event::AfterPost | Event::BeforeReverse | Event::AfterReverse)
    }
    /// After-commit events run after the transaction commits (from the outbox).
    pub fn after_commit(self) -> bool {
        matches!(self, Event::AfterCreate | Event::AfterSave | Event::AfterPost | Event::AfterReverse | Event::AfterDelete)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HandlerDecl {
    pub target: String,
    pub target_span: Span,
    pub event: Event,
    pub param: String,
    pub body: Vec<Stmt>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssignOp {
    Set,
    Add,
    Sub,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    Let { name: String, value: Expr, span: Span },
    Assign { target: Expr, op: AssignOp, value: Expr, span: Span },
    If { cond: Expr, then: Vec<Stmt>, otherwise: Option<Vec<Stmt>>, span: Span },
    While { cond: Expr, body: Vec<Stmt>, span: Span },
    For { var: String, iter: Expr, body: Vec<Stmt>, span: Span },
    Return { value: Option<Expr>, span: Span },
    Break { span: Span },
    Continue { span: Span },
    Expr { expr: Expr, span: Span },
}

impl Stmt {
    pub fn span(&self) -> Span {
        match self {
            Stmt::Let { span, .. }
            | Stmt::Assign { span, .. }
            | Stmt::If { span, .. }
            | Stmt::While { span, .. }
            | Stmt::For { span, .. }
            | Stmt::Return { span, .. }
            | Stmt::Break { span }
            | Stmt::Continue { span }
            | Stmt::Expr { span, .. } => *span,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    And,
    Or,
}

impl BinaryOp {
    pub fn symbol(self) -> &'static str {
        match self {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Rem => "%",
            BinaryOp::Eq => "==",
            BinaryOp::NotEq => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::LtEq => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::GtEq => ">=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Arg {
    pub name: Option<String>,
    pub value: Expr,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    Int(i64),
    Decimal(Decimal),
    Str(String),
    Bool(bool),
    Null,
    Ident(String),
    Array(Vec<Expr>),
    Map(Vec<(String, Expr)>),
    Member { object: Box<Expr>, name: String },
    Index { object: Box<Expr>, index: Box<Expr> },
    Call { callee: Box<Expr>, args: Vec<Arg> },
    Unary { op: UnaryOp, expr: Box<Expr> },
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}
