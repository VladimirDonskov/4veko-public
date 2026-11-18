use std::fmt;
use vks_syntax::{Kind, Span};

/// A runtime error with the position of the expression or statement that raised it.
#[derive(Debug, Clone, PartialEq)]
pub struct RtError {
    pub code: &'static str,
    pub kind: Kind,
    pub message: String,
    pub span: Span,
}

impl RtError {
    pub fn new(code: &'static str, kind: Kind, message: impl Into<String>, span: Span) -> Self {
        RtError { code, kind, message: message.into(), span }
    }
    pub fn kind_name(&self) -> &'static str {
        match self.kind {
            Kind::Syntax => "syntax",
            Kind::Semantic => "semantic",
            Kind::Metadata => "metadata",
            Kind::Type => "type",
            Kind::Runtime => "runtime",
            Kind::Rejected => "rejected",
            Kind::Limit => "limit",
            Kind::Permission => "permission",
            Kind::Host => "host",
        }
    }
}

impl fmt::Display for RtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {} error [{}] {}", self.span.line, self.span.col, self.kind_name(), self.code, self.message)
    }
}

pub type RtResult<T> = Result<T, RtError>;

/// Runtime error codes. Kept in one place so documentation and tooling can list them.
pub mod codes {
    pub const TYPE: &str = "VKS4001";
    pub const CONDITION: &str = "VKS4002";
    pub const INT_OVERFLOW: &str = "VKS4003";
    pub const DIV_ZERO: &str = "VKS4004";
    pub const DEC_OVERFLOW: &str = "VKS4005";
    pub const INDEX_RANGE: &str = "VKS4006";
    pub const INDEX_TYPE: &str = "VKS4007";
    pub const NULL_ACCESS: &str = "VKS4008";
    pub const NO_MEMBER: &str = "VKS4009";
    pub const NOT_CALLABLE: &str = "VKS4010";
    pub const ARGS: &str = "VKS4011";
    pub const CONVERSION: &str = "VKS4012";
    pub const COMPARE: &str = "VKS4013";
    pub const FIELD_TYPE: &str = "VKS4014";
    pub const READ_ONLY: &str = "VKS4015";
    pub const CURRENCY: &str = "VKS4016";
    pub const DATE_MATH: &str = "VKS4017";
    pub const REGISTER: &str = "VKS4018";
    pub const NOT_SAVED: &str = "VKS4019";
    pub const NOT_ITERABLE: &str = "VKS4020";
    pub const REQUIRED: &str = "VKS4021";
    pub const OBJECT_STATE: &str = "VKS4022";
    pub const NO_ENTRY: &str = "VKS4023";
    pub const REJECTED: &str = "VKS4100";
    pub const STEPS: &str = "VKS4200";
    pub const TIME: &str = "VKS4201";
    pub const CALL_DEPTH: &str = "VKS4202";
    pub const COLLECTION: &str = "VKS4203";
    pub const STRING: &str = "VKS4204";
    pub const MEMORY: &str = "VKS4205";
    pub const HOST_CALLS: &str = "VKS4206";
    pub const QUERIES: &str = "VKS4207";
    pub const EVENT_DEPTH: &str = "VKS4208";
    pub const STACK: &str = "VKS4209";
    pub const PERMISSION: &str = "VKS4300";
    pub const HOST: &str = "VKS4400";
    pub const HOST_NOT_FOUND: &str = "VKS4401";
    pub const HOST_VALIDATION: &str = "VKS4402";
    pub const HOST_CONFLICT: &str = "VKS4403";
    pub const HOST_UNSUPPORTED: &str = "VKS4404";
}
