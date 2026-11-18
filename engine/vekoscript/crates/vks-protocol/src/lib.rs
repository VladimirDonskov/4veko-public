//! Host protocol `vks/1`: the messages exchanged between an isolated VekoScript worker and the
//! Java platform. Transport: one JSON object per line on the worker's stdin/stdout.
//!
//! Every message is an [`Envelope`]. The platform sends `check`, `plan` and `execute`
//! requests; while executing, the worker sends `hostCall` requests and waits for the matching
//! `hostResult`. The platform may start a nested `execute` (for example to run BeforeSave of
//! an object the script is saving) before answering; the worker handles it re-entrantly.
//!
//! Values cross the boundary in [`WireValue`] form: decimals and dates are strings, so no
//! precision is lost to JSON numbers.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use vks_metadata::{MetadataModel, MigrationPlan, ObjectKind};
use vks_syntax::ast::Event;
use vks_syntax::Diagnostic;

pub const PROTOCOL: &str = "vks/1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum WireValue {
    Null,
    Bool(bool),
    Int(i64),
    /// Exact decimal as text, e.g. "1250.00".
    Dec(String),
    Str(String),
    /// ISO date "2026-10-28".
    Date(String),
    /// RFC 3339 UTC "2026-10-28T14:30:00Z".
    DateTime(String),
    /// Whole seconds.
    Duration(i64),
    Money {
        amount: String,
        currency: String,
    },
    Array(Vec<WireValue>),
    /// Ordered key/value pairs.
    Map(Vec<(String, WireValue)>),
    Ref {
        kind: ObjectKind,
        #[serde(rename = "type")]
        type_name: String,
        id: String,
    },
    Object(Box<WireObject>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRow {
    #[serde(default)]
    pub line_no: Option<u32>,
    pub fields: BTreeMap<String, WireValue>,
}

/// A catalog record or document as data. System fields are explicit; declared fields and rows
/// are keyed by their metadata names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireObject {
    pub kind: ObjectKind,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    /// Documents: "draft", "posted" or "reversed".
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub fields: BTreeMap<String, WireValue>,
    #[serde(default)]
    pub rows: BTreeMap<String, Vec<WireRow>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// Missing fields take their default, so a platform can set only the limits it cares about.
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub max_steps: u64,
    pub max_millis: u64,
    pub max_call_depth: u32,
    pub max_collection_len: usize,
    pub max_string_bytes: usize,
    /// Estimated bytes allocated by script values (an upper bound; the worker also has an
    /// operating-system memory limit).
    pub max_memory_bytes: usize,
    pub max_host_calls: u32,
    pub max_queries: u32,
    /// Nested executions (an event handler that saves an object whose handler saves another…).
    pub max_event_depth: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_steps: 5_000_000,
            max_millis: 5_000,
            max_call_depth: 128,
            max_collection_len: 100_000,
            max_string_bytes: 1_000_000,
            max_memory_bytes: 64 * 1024 * 1024,
            max_host_calls: 10_000,
            max_queries: 1_000,
            max_event_depth: 8,
        }
    }
}

/// Who is running what. Prepared by the platform; immutable during execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecContext {
    pub organization: String,
    pub user: String,
    pub application: String,
    pub script_version: u32,
    /// e.g. "catalog.read", "catalog.write", "document.write", "document.post", "register.read".
    pub capabilities: Vec<String>,
    /// The business operation this execution belongs to, e.g. "post GoodsReceipt GR-1001".
    pub operation: String,
    /// Clock for now()/today(), fixed per execution for determinism.
    pub now: String,
    pub correlation_id: String,
    #[serde(default)]
    pub event_depth: u32,
    #[serde(default)]
    pub limits: Limits,
}

impl ExecContext {
    pub fn can(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability || c == "*")
    }
}

/// What to run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    /// Top-level statements of the program.
    Script,
    /// An event handler with the object it is about.
    Handler { target: String, event: Event, object: WireObject },
    /// A named function with arguments.
    Function { name: String, args: Vec<WireValue> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// Cache key, e.g. "org-1/app/v3"; same key must mean same source.
    pub key: String,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    In,
    Out,
}

/// A change the script asks the platform to make as part of the current operation.
/// The platform validates every intent and applies them all in one transaction, or none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Intent {
    RegisterMovement { register: String, direction: Direction, dimensions: BTreeMap<String, WireValue>, measures: BTreeMap<String, WireValue> },
    AccountingEntry { debit: String, credit: String, amount: String, currency: String, memo: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecError {
    pub code: String,
    /// syntax, semantic, metadata, type, runtime, rejected, limit, permission or host.
    pub kind: String,
    pub message: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub steps: u64,
    pub host_calls: u32,
    pub queries: u32,
    pub micros: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub ok: bool,
    /// Return value of a function or script.
    pub value: Option<WireValue>,
    /// The handler's object after it ran (BeforeSave/BeforeCreate may change fields).
    pub object: Option<WireObject>,
    pub intents: Vec<Intent>,
    pub logs: Vec<LogEntry>,
    pub error: Option<ExecError>,
    pub stats: Stats,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum HostCall {
    FindById {
        kind: ObjectKind,
        #[serde(rename = "type")]
        type_name: String,
        id: String,
    },
    FindBy {
        kind: ObjectKind,
        #[serde(rename = "type")]
        type_name: String,
        field: String,
        value: WireValue,
    },
    List {
        kind: ObjectKind,
        #[serde(rename = "type")]
        type_name: String,
        filter: BTreeMap<String, WireValue>,
        limit: u32,
        offset: u32,
    },
    Save {
        object: WireObject,
    },
    Delete {
        kind: ObjectKind,
        #[serde(rename = "type")]
        type_name: String,
        id: String,
    },
    Post {
        #[serde(rename = "type")]
        type_name: String,
        id: String,
    },
    Reverse {
        #[serde(rename = "type")]
        type_name: String,
        id: String,
    },
    RegisterBalance {
        register: String,
        dimensions: BTreeMap<String, WireValue>,
        at: Option<String>,
    },
}

impl HostCall {
    /// The capability the platform requires for this call.
    pub fn capability(&self) -> &'static str {
        match self {
            HostCall::FindById { kind, .. } | HostCall::FindBy { kind, .. } | HostCall::List { kind, .. } => match kind {
                ObjectKind::Catalog => "catalog.read",
                ObjectKind::Document => "document.read",
            },
            HostCall::Save { object } => match object.kind {
                ObjectKind::Catalog => "catalog.write",
                ObjectKind::Document => "document.write",
            },
            HostCall::Delete { kind, .. } => match kind {
                ObjectKind::Catalog => "catalog.write",
                ObjectKind::Document => "document.write",
            },
            HostCall::Post { .. } | HostCall::Reverse { .. } => "document.post",
            HostCall::RegisterBalance { .. } => "register.read",
        }
    }
    pub fn is_query(&self) -> bool {
        matches!(self, HostCall::FindById { .. } | HostCall::FindBy { .. } | HostCall::List { .. } | HostCall::RegisterBalance { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    /// "permission", "notFound", "validation", "conflict", "rejected", "unsupported", "internal".
    pub code: String,
    pub message: String,
}

/// A diagnostic as data (the in-process form borrows its code as `&'static str`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireDiagnostic {
    pub code: String,
    pub kind: String,
    /// "error" or "warning".
    pub severity: String,
    pub message: String,
    pub line: u32,
    pub col: u32,
    pub offset: u32,
    pub len: u32,
}

impl From<&Diagnostic> for WireDiagnostic {
    fn from(d: &Diagnostic) -> Self {
        let kind = serde_json::to_value(d.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        let severity = serde_json::to_value(d.severity).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        WireDiagnostic { code: d.code.to_string(), kind, severity, message: d.message.clone(), line: d.span.line, col: d.span.col, offset: d.span.offset, len: d.span.len }
    }
}

/// An event handler present in a program, so the platform only calls the worker when needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerInfo {
    pub target: String,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum Message {
    /// Validate an application (metadata and logic). `script: true` also allows top-level
    /// statements, as in a script run from the command line.
    Check {
        source: String,
        #[serde(default)]
        script: bool,
    },
    CheckResult {
        diagnostics: Vec<WireDiagnostic>,
        metadata: Option<MetadataModel>,
        handlers: Vec<HandlerInfo>,
    },
    Plan {
        source: String,
        previous: Option<MetadataModel>,
    },
    PlanResult {
        diagnostics: Vec<WireDiagnostic>,
        metadata: Option<MetadataModel>,
        plan: Option<MigrationPlan>,
    },
    Execute {
        program: Program,
        context: ExecContext,
        entry: Entry,
    },
    ExecuteResult(ExecuteResult),
    HostCall(HostCall),
    HostResult {
        ok: Option<WireValue>,
        error: Option<HostError>,
    },
    Shutdown,
    ProtocolError {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub protocol: String,
    /// Correlates requests and responses; a response carries its request's id.
    pub id: u64,
    #[serde(flatten)]
    pub message: Message,
}

impl Envelope {
    pub fn new(id: u64, message: Message) -> Self {
        Envelope { protocol: PROTOCOL.to_string(), id, message }
    }
}
