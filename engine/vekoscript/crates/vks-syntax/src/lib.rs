//! VekoScript syntax: tokens, syntax tree, parser and diagnostics.

pub mod ast;
pub mod diagnostics;
pub mod lexer;
pub mod parser;

pub use diagnostics::{has_errors, Diagnostic, Kind, Severity, Span};
pub use parser::{parse, ParseResult};
