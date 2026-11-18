use serde::Serialize;
use std::fmt;

/// A position in source text. Lines and columns are 1-based; columns count characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Span {
    pub line: u32,
    pub col: u32,
    /// Byte offset of the first character.
    pub offset: u32,
    /// Length in bytes.
    pub len: u32,
}

impl Span {
    pub fn to(self, end: Span) -> Span {
        Span { len: (end.offset + end.len).saturating_sub(self.offset), ..self }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// What kind of problem a diagnostic or runtime error reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Syntax,
    Semantic,
    Metadata,
    Type,
    Runtime,
    Rejected,
    Limit,
    Permission,
    Host,
}

/// A problem found in a script, with a stable code for tooling (e.g. "VKS1001").
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: &'static str,
    pub kind: Kind,
    pub severity: Severity,
    pub message: String,
    pub span: Span,
}

impl Diagnostic {
    pub fn error(code: &'static str, kind: Kind, message: impl Into<String>, span: Span) -> Self {
        Diagnostic { code, kind, severity: Severity::Error, message: message.into(), span }
    }
    pub fn warning(code: &'static str, kind: Kind, message: impl Into<String>, span: Span) -> Self {
        Diagnostic { code, kind, severity: Severity::Warning, message: message.into(), span }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {} [{}] {}", self.span.line, self.span.col, severity_word(self.severity), self.code, self.message)
    }
}

fn severity_word(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

pub fn has_errors(diags: &[Diagnostic]) -> bool {
    diags.iter().any(|d| d.severity == Severity::Error)
}
