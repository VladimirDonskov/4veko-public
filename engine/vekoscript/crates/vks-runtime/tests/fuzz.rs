//! Randomized robustness tests on stable Rust. Deterministic pseudo-random inputs (random
//! bytes, token soup and mutations of a real application) go through the lexer, parser,
//! metadata validator, analyzer and interpreter. The property: nothing panics, every run ends
//! with a value or a reported error, and limits hold. These are not coverage-guided; a
//! `cargo fuzz` target is a follow-up that needs a nightly toolchain.

use vks_protocol::{Entry, ExecContext, Limits};
use vks_runtime::{compile, execute, NoHost, Options};

const INVENTORY: &str = include_str!("../../../examples/inventory.vks");

/// xorshift64*: small, deterministic, good enough to explore inputs.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const TOKENS: &[&str] = &[
    "let",
    "function",
    "return",
    "if",
    "else",
    "while",
    "for",
    "in",
    "break",
    "continue",
    "on",
    "true",
    "false",
    "null",
    "catalog",
    "document",
    "register",
    "field",
    "rows",
    "dimension",
    "measure",
    "required",
    "unique",
    "default",
    "String(10)",
    "Decimal(18, 2)",
    "Integer",
    "Ref<A>",
    "A",
    "B",
    "x",
    "y",
    "f",
    "Catalog",
    "Document",
    "Register",
    "Context",
    "str",
    "round",
    "range",
    "reject",
    "format",
    "0",
    "1",
    "-1",
    "9223372036854775807",
    "1.5",
    "0.001",
    "\"s\"",
    "\"\\u{41}\"",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    ";",
    ",",
    ".",
    ":",
    "+",
    "-",
    "*",
    "/",
    "%",
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "&&",
    "||",
    "!",
    "=",
    "+=",
    "-=",
    "\n",
    "//c\n",
    "/*",
    "*/",
];

fn ctx() -> ExecContext {
    ExecContext {
        organization: "o".into(),
        user: "u".into(),
        application: "fuzz".into(),
        script_version: 1,
        capabilities: vec!["*".into()],
        operation: "fuzz".into(),
        now: "2026-10-28T00:00:00Z".into(),
        correlation_id: "f".into(),
        event_depth: 0,
        limits: Limits { max_steps: 20_000, max_millis: 200, max_collection_len: 1_000, max_string_bytes: 10_000, max_memory_bytes: 1_000_000, ..Limits::default() },
    }
}

/// Compile and, when the input is a valid script, run it under small limits.
fn exercise(src: &str) {
    let (program, diags) = compile(src, Options { allow_script: true });
    for d in &diags {
        assert!(d.span.offset as usize <= src.len(), "diagnostic outside the source: {d:?}");
    }
    if let Some(p) = program {
        if p.script.is_some() {
            let r = execute(&p, &ctx(), &Entry::Script, &mut NoHost);
            assert_eq!(r.ok, r.error.is_none());
        }
    }
}

#[test]
fn random_bytes_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..3_000 {
        let len = rng.below(200);
        let bytes: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
        exercise(&String::from_utf8_lossy(&bytes));
    }
}

#[test]
fn token_soup_never_panics() {
    let mut rng = Rng(42);
    for _ in 0..5_000 {
        let n = 1 + rng.below(60);
        let src: Vec<&str> = (0..n).map(|_| TOKENS[rng.below(TOKENS.len())]).collect();
        exercise(&src.join(" "));
    }
}

#[test]
fn mutated_application_never_panics() {
    let mut rng = Rng(7);
    let base: Vec<char> = INVENTORY.chars().collect();
    for _ in 0..1_500 {
        let mut s = base.clone();
        for _ in 0..1 + rng.below(6) {
            let at = rng.below(s.len());
            match rng.below(3) {
                0 => {
                    s.remove(at);
                }
                1 => s.insert(at, TOKENS[rng.below(TOKENS.len())].chars().next().unwrap_or(' ')),
                _ => {
                    let end = (at + rng.below(20)).min(s.len());
                    s.drain(at..end);
                }
            }
        }
        let src: String = s.into_iter().collect();
        exercise(&format!("{src}\nlet z = 1;"));
    }
}

#[test]
fn generated_programs_stay_within_limits() {
    // Well-formed programs built from statement templates; they run to completion or stop at
    // a limit, never hang or exhaust memory.
    let templates = [
        "let a{i} = [1, 2, 3]; a{i}.add({i});",
        "let m{i} = {{ k: {i} }}; m{i}.k += 1;",
        "let s{i} = \"x\"; for j in range({i}) {{ s{i} += \"y\"; }}",
        "let n{i} = 0; while n{i} < {i} {{ n{i} += 1; }}",
        "function g{i}(v) {{ if v <= 0 {{ return 0; }} return g{i}(v - 1) + 1; }} let r{i} = g{i}({i});",
        "let d{i} = round({i} / 7, 2) * 3.25;",
        "let t{i} = date(\"2026-01-01\") + days({i});",
        "let q{i} = [{i}, 1].sum() % 5;",
        "let w{i} = 0; while true {{ w{i} += 1; }}",
        "let big{i} = \"ab\"; while true {{ big{i} = big{i} + big{i}; }}",
    ];
    let mut rng = Rng(99);
    for _ in 0..400 {
        let mut src = String::new();
        for i in 0..1 + rng.below(6) {
            src.push_str(&templates[rng.below(templates.len())].replace("{i}", &(i * 37 % 200).to_string()).replace("{{", "{").replace("}}", "}"));
            src.push('\n');
        }
        let (program, diags) = compile(&src, Options { allow_script: true });
        let program = program.unwrap_or_else(|| panic!("{src}\n{diags:#?}"));
        let r = execute(&program, &ctx(), &Entry::Script, &mut NoHost);
        if let Some(e) = &r.error {
            assert!(matches!(e.kind.as_str(), "limit" | "runtime" | "type"), "{src}\n{e:?}");
        }
        assert!(r.stats.steps <= 20_001);
    }
}
