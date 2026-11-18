use crate::diagnostics::{Diagnostic, Kind, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Ident(String),
    Int(String),
    Decimal(String),
    Str(String),
    // Keywords
    Let,
    Function,
    Return,
    If,
    Else,
    While,
    For,
    In,
    Break,
    Continue,
    On,
    Catalog,
    Document,
    Register,
    Information,
    Periodic,
    Field,
    Rows,
    Dimension,
    Measure,
    Resource,
    Required,
    Unique,
    Default,
    True,
    False,
    Null,
    // Punctuation and operators
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Comma,
    Colon,
    Semi,
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Assign,
    PlusAssign,
    MinusAssign,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    AndAnd,
    OrOr,
    Bang,
    Eof,
}

impl Tok {
    pub fn describe(&self) -> String {
        match self {
            Tok::Ident(s) => format!("identifier \"{s}\""),
            Tok::Int(s) | Tok::Decimal(s) => format!("number {s}"),
            Tok::Str(_) => "a string".into(),
            Tok::Eof => "the end of the file".into(),
            other => format!("\"{}\"", symbol(other)),
        }
    }
}

pub fn symbol(t: &Tok) -> &'static str {
    match t {
        Tok::Let => "let",
        Tok::Function => "function",
        Tok::Return => "return",
        Tok::If => "if",
        Tok::Else => "else",
        Tok::While => "while",
        Tok::For => "for",
        Tok::In => "in",
        Tok::Break => "break",
        Tok::Continue => "continue",
        Tok::On => "on",
        Tok::Catalog => "catalog",
        Tok::Document => "document",
        Tok::Register => "register",
        Tok::Information => "information",
        Tok::Periodic => "periodic",
        Tok::Field => "field",
        Tok::Rows => "rows",
        Tok::Dimension => "dimension",
        Tok::Measure => "measure",
        Tok::Resource => "resource",
        Tok::Required => "required",
        Tok::Unique => "unique",
        Tok::Default => "default",
        Tok::True => "true",
        Tok::False => "false",
        Tok::Null => "null",
        Tok::LParen => "(",
        Tok::RParen => ")",
        Tok::LBrace => "{",
        Tok::RBrace => "}",
        Tok::LBracket => "[",
        Tok::RBracket => "]",
        Tok::Comma => ",",
        Tok::Colon => ":",
        Tok::Semi => ";",
        Tok::Dot => ".",
        Tok::Plus => "+",
        Tok::Minus => "-",
        Tok::Star => "*",
        Tok::Slash => "/",
        Tok::Percent => "%",
        Tok::Assign => "=",
        Tok::PlusAssign => "+=",
        Tok::MinusAssign => "-=",
        Tok::Eq => "==",
        Tok::NotEq => "!=",
        Tok::Lt => "<",
        Tok::LtEq => "<=",
        Tok::Gt => ">",
        Tok::GtEq => ">=",
        Tok::AndAnd => "&&",
        Tok::OrOr => "||",
        Tok::Bang => "!",
        _ => "?",
    }
}

fn keyword(word: &str) -> Option<Tok> {
    Some(match word {
        "let" => Tok::Let,
        "function" => Tok::Function,
        "return" => Tok::Return,
        "if" => Tok::If,
        "else" => Tok::Else,
        "while" => Tok::While,
        "for" => Tok::For,
        "in" => Tok::In,
        "break" => Tok::Break,
        "continue" => Tok::Continue,
        "on" => Tok::On,
        "true" => Tok::True,
        "false" => Tok::False,
        "null" => Tok::Null,
        _ => return None,
    })
}

#[derive(Debug, Clone)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

/// Maximum accepted source size (bytes); larger inputs are rejected before lexing.
pub const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

/// Turn source text into tokens. Lexical errors are reported and the bad character skipped,
/// so the parser can still report later problems.
pub fn tokenize(src: &str) -> (Vec<Token>, Vec<Diagnostic>) {
    let mut out = Vec::new();
    let mut diags = Vec::new();
    if src.len() > MAX_SOURCE_BYTES {
        diags.push(Diagnostic::error("VKS1006", Kind::Syntax, "The script is larger than 2 MB.", Span { line: 1, col: 1, offset: 0, len: 0 }));
        out.push(Token { tok: Tok::Eof, span: Span { line: 1, col: 1, offset: 0, len: 0 } });
        return (out, diags);
    }
    let chars: Vec<(usize, char)> = src.char_indices().collect();
    let mut i = 0usize;
    let mut line = 1u32;
    let mut col = 1u32;

    macro_rules! advance {
        () => {{
            let c = chars[i].1;
            i += 1;
            if c == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }};
    }
    let byte_at = |idx: usize| chars.get(idx).map(|c| c.0).unwrap_or(src.len());

    while i < chars.len() {
        let c = chars[i].1;
        let start = Span { line, col, offset: byte_at(i) as u32, len: 0 };
        if c.is_whitespace() {
            advance!();
            continue;
        }
        if c == '/' && chars.get(i + 1).map(|x| x.1) == Some('/') {
            while i < chars.len() && chars[i].1 != '\n' {
                advance!();
            }
            continue;
        }
        if c == '/' && chars.get(i + 1).map(|x| x.1) == Some('*') {
            advance!();
            advance!();
            let mut closed = false;
            while i < chars.len() {
                if chars[i].1 == '*' && chars.get(i + 1).map(|x| x.1) == Some('/') {
                    advance!();
                    advance!();
                    closed = true;
                    break;
                }
                advance!();
            }
            if !closed {
                diags.push(Diagnostic::error("VKS1005", Kind::Syntax, "This comment is never closed with */.", start));
            }
            continue;
        }
        let finish = |end_idx: usize, span: Span| Span { len: (byte_at(end_idx) - span.offset as usize) as u32, ..span };

        if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && chars[j].1.is_ascii_digit() {
                j += 1;
            }
            let mut is_decimal = false;
            if j + 1 < chars.len() && chars[j].1 == '.' && chars[j + 1].1.is_ascii_digit() {
                is_decimal = true;
                j += 1;
                while j < chars.len() && chars[j].1.is_ascii_digit() {
                    j += 1;
                }
            }
            if j < chars.len() && (chars[j].1.is_alphabetic() || chars[j].1 == '_') {
                diags.push(Diagnostic::error("VKS1002", Kind::Syntax, "A number cannot be followed directly by letters.", start));
            }
            let text: String = chars[i..j].iter().map(|c| c.1).collect();
            while i < j {
                advance!();
            }
            out.push(Token { tok: if is_decimal { Tok::Decimal(text) } else { Tok::Int(text) }, span: finish(i, start) });
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < chars.len() && (chars[j].1.is_alphanumeric() || chars[j].1 == '_') {
                j += 1;
            }
            let word: String = chars[i..j].iter().map(|c| c.1).collect();
            if !word.is_ascii() {
                diags.push(Diagnostic::error("VKS1007", Kind::Syntax, format!("Identifiers use English letters, digits and _ only: \"{word}\"."), start));
            }
            while i < j {
                advance!();
            }
            let tok = keyword(&word).unwrap_or(Tok::Ident(word));
            out.push(Token { tok, span: finish(i, start) });
            continue;
        }
        if c == '"' {
            advance!();
            let mut s = String::new();
            let mut closed = false;
            while i < chars.len() {
                let ch = chars[i].1;
                if ch == '"' {
                    advance!();
                    closed = true;
                    break;
                }
                if ch == '\n' {
                    break;
                }
                if ch == '\\' {
                    let esc_span = Span { line, col, offset: byte_at(i) as u32, len: 2 };
                    advance!();
                    let Some(&(_, e)) = chars.get(i) else { break };
                    advance!();
                    match e {
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        'r' => s.push('\r'),
                        '"' => s.push('"'),
                        '\\' => s.push('\\'),
                        'u' => {
                            // \u{XXXX}
                            if chars.get(i).map(|c| c.1) == Some('{') {
                                advance!();
                                let mut hex = String::new();
                                while i < chars.len() && chars[i].1 != '}' && hex.len() < 7 {
                                    hex.push(chars[i].1);
                                    advance!();
                                }
                                if chars.get(i).map(|c| c.1) == Some('}') {
                                    advance!();
                                }
                                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                                    Some(ch) => s.push(ch),
                                    None => diags.push(Diagnostic::error("VKS1004", Kind::Syntax, "Invalid \\u{...} escape.", esc_span)),
                                }
                            } else {
                                diags.push(Diagnostic::error("VKS1004", Kind::Syntax, "Write unicode escapes as \\u{1F600}.", esc_span));
                            }
                        }
                        other => diags.push(Diagnostic::error("VKS1004", Kind::Syntax, format!("Unknown escape \\{other}."), esc_span)),
                    }
                    continue;
                }
                s.push(ch);
                advance!();
            }
            if !closed {
                diags.push(Diagnostic::error("VKS1003", Kind::Syntax, "This string is missing its closing quote.", start));
            }
            out.push(Token { tok: Tok::Str(s), span: finish(i, start) });
            continue;
        }
        let next = chars.get(i + 1).map(|x| x.1);
        let (tok, width) = match (c, next) {
            ('=', Some('=')) => (Tok::Eq, 2),
            ('!', Some('=')) => (Tok::NotEq, 2),
            ('<', Some('=')) => (Tok::LtEq, 2),
            ('>', Some('=')) => (Tok::GtEq, 2),
            ('&', Some('&')) => (Tok::AndAnd, 2),
            ('|', Some('|')) => (Tok::OrOr, 2),
            ('+', Some('=')) => (Tok::PlusAssign, 2),
            ('-', Some('=')) => (Tok::MinusAssign, 2),
            ('(', _) => (Tok::LParen, 1),
            (')', _) => (Tok::RParen, 1),
            ('{', _) => (Tok::LBrace, 1),
            ('}', _) => (Tok::RBrace, 1),
            ('[', _) => (Tok::LBracket, 1),
            (']', _) => (Tok::RBracket, 1),
            (',', _) => (Tok::Comma, 1),
            (':', _) => (Tok::Colon, 1),
            (';', _) => (Tok::Semi, 1),
            ('.', _) => (Tok::Dot, 1),
            ('+', _) => (Tok::Plus, 1),
            ('-', _) => (Tok::Minus, 1),
            ('*', _) => (Tok::Star, 1),
            ('/', _) => (Tok::Slash, 1),
            ('%', _) => (Tok::Percent, 1),
            ('=', _) => (Tok::Assign, 1),
            ('<', _) => (Tok::Lt, 1),
            ('>', _) => (Tok::Gt, 1),
            ('!', _) => (Tok::Bang, 1),
            _ => {
                diags.push(Diagnostic::error("VKS1001", Kind::Syntax, format!("Unexpected character '{c}'."), Span { len: c.len_utf8() as u32, ..start }));
                advance!();
                continue;
            }
        };
        for _ in 0..width {
            advance!();
        }
        out.push(Token { tok, span: finish(i, start) });
    }
    out.push(Token { tok: Tok::Eof, span: Span { line, col, offset: src.len() as u32, len: 0 } });
    (out, diags)
}
