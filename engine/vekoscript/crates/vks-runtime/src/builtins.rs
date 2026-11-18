//! Built-in functions: the global part of the standard library. Methods on values live in
//! `stdlib.rs`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Builtin {
    Str,
    Int,
    Decimal,
    Bool,
    Round,
    Abs,
    Min,
    Max,
    Date,
    DateTime,
    Now,
    Today,
    Days,
    Hours,
    Minutes,
    Seconds,
    Money,
    Format,
    TypeOf,
    Reject,
    Notify,
    Log,
    Range,
}

pub const ALL: &[Builtin] = &[
    Builtin::Str,
    Builtin::Int,
    Builtin::Decimal,
    Builtin::Bool,
    Builtin::Round,
    Builtin::Abs,
    Builtin::Min,
    Builtin::Max,
    Builtin::Date,
    Builtin::DateTime,
    Builtin::Now,
    Builtin::Today,
    Builtin::Days,
    Builtin::Hours,
    Builtin::Minutes,
    Builtin::Seconds,
    Builtin::Money,
    Builtin::Format,
    Builtin::TypeOf,
    Builtin::Reject,
    Builtin::Notify,
    Builtin::Log,
    Builtin::Range,
];

/// How a built-in takes arguments: parameter names (for named arguments), how many are
/// required, and whether more positional arguments are accepted.
pub struct Signature {
    pub params: &'static [&'static str],
    pub required: usize,
    pub variadic: bool,
}

impl Builtin {
    pub fn name(self) -> &'static str {
        match self {
            Builtin::Str => "str",
            Builtin::Int => "int",
            Builtin::Decimal => "decimal",
            Builtin::Bool => "bool",
            Builtin::Round => "round",
            Builtin::Abs => "abs",
            Builtin::Min => "min",
            Builtin::Max => "max",
            Builtin::Date => "date",
            Builtin::DateTime => "dateTime",
            Builtin::Now => "now",
            Builtin::Today => "today",
            Builtin::Days => "days",
            Builtin::Hours => "hours",
            Builtin::Minutes => "minutes",
            Builtin::Seconds => "seconds",
            Builtin::Money => "money",
            Builtin::Format => "format",
            Builtin::TypeOf => "typeOf",
            Builtin::Reject => "reject",
            Builtin::Notify => "notify",
            Builtin::Log => "log",
            Builtin::Range => "range",
        }
    }

    pub fn from_name(n: &str) -> Option<Builtin> {
        ALL.iter().copied().find(|b| b.name() == n)
    }

    pub fn signature(self) -> Signature {
        let s = |params: &'static [&'static str], required: usize| Signature { params, required, variadic: false };
        match self {
            Builtin::Str | Builtin::Int | Builtin::Decimal | Builtin::Bool | Builtin::Abs | Builtin::TypeOf => s(&["value"], 1),
            Builtin::Round => s(&["value", "places", "mode"], 1),
            Builtin::Min | Builtin::Max => Signature { params: &["a", "b"], required: 2, variadic: true },
            Builtin::Date => s(&["value", "month", "day"], 1),
            Builtin::DateTime => s(&["value"], 1),
            Builtin::Now | Builtin::Today => s(&[], 0),
            Builtin::Days | Builtin::Hours | Builtin::Minutes | Builtin::Seconds => s(&["count"], 1),
            Builtin::Money => s(&["amount", "currency"], 2),
            Builtin::Format => Signature { params: &["template"], required: 1, variadic: true },
            Builtin::Reject | Builtin::Notify | Builtin::Log => s(&["message"], 1),
            Builtin::Range => s(&["start", "end"], 1),
        }
    }
}
