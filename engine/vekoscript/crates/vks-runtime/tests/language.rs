//! Language semantics: values, operators, conversions, control flow, functions, scoping,
//! errors and limits. Scripts run with no platform attached.

use vks_protocol::{Entry, ExecContext, ExecError, ExecuteResult, Limits, WireValue};
use vks_runtime::{compile, execute, NoHost, Options};

fn ctx(limits: Limits) -> ExecContext {
    ExecContext {
        organization: "org-1".into(),
        user: "tester".into(),
        application: "language-tests".into(),
        script_version: 1,
        capabilities: vec!["*".into()],
        operation: "test".into(),
        now: "2026-10-28T09:30:00Z".into(),
        correlation_id: "t-1".into(),
        event_depth: 0,
        limits,
    }
}

fn run_with(src: &str, limits: Limits) -> ExecuteResult {
    let (program, diags) = compile(src, Options { allow_script: true });
    let program = program.unwrap_or_else(|| panic!("does not compile: {diags:#?}"));
    execute(&program, &ctx(limits), &Entry::Script, &mut NoHost)
}

fn value(src: &str) -> WireValue {
    let r = run_with(src, Limits::default());
    assert!(r.ok, "{src}\n{:?}", r.error);
    r.value.expect("script returns a value")
}

fn error(src: &str) -> ExecError {
    let r = run_with(src, Limits::default());
    assert!(!r.ok, "expected an error from {src}, got {:?}", r.value);
    r.error.unwrap()
}

fn limit_error(src: &str, limits: Limits) -> ExecError {
    let r = run_with(src, limits);
    assert!(!r.ok, "expected a limit error from {src}");
    r.error.unwrap()
}

fn semantic(src: &str) -> Vec<&'static str> {
    compile(src, Options { allow_script: true }).1.iter().map(|d| d.code).collect()
}

fn int(i: i64) -> WireValue {
    WireValue::Int(i)
}
fn dec(s: &str) -> WireValue {
    WireValue::Dec(s.into())
}
fn text(s: &str) -> WireValue {
    WireValue::Str(s.into())
}

#[test]
fn arithmetic_precedence_and_exact_decimals() {
    assert_eq!(value("return 1 + 2 * 3;"), int(7));
    assert_eq!(value("return (1 + 2) * 3;"), int(9));
    assert_eq!(value("return 2 - 3 - 4;"), int(-5));
    assert_eq!(value("return 10 % 3;"), int(1));
    assert_eq!(value("return -2 * 3;"), int(-6));
    assert_eq!(value("return 7 / 2;"), dec("3.5"));
    assert_eq!(value("return 6 / 3;"), dec("2"));
    assert_eq!(value("return 1 / 3;"), dec("0.3333333333333333333333333333"));
    assert_eq!(value("return 0.1 + 0.2 == 0.3;"), WireValue::Bool(true));
    assert_eq!(value("return 1.50 + 1;"), dec("2.50"));
    assert_eq!(value("return 2.5 * 4;"), dec("10.0"));
    assert_eq!(value("return 1 + 2 == 3 && 4 > 3 || false;"), WireValue::Bool(true));
    assert_eq!(value("return -9223372036854775808;"), int(i64::MIN));
}

#[test]
fn checked_integers_and_division_by_zero() {
    assert_eq!(error("return 9223372036854775807 + 1;").code, "VKS4003");
    assert_eq!(error("return -9223372036854775808 * -1;").code, "VKS4003");
    assert_eq!(error("return 1 / 0;").code, "VKS4004");
    assert_eq!(error("return 1.5 % 0;").code, "VKS4004");
    assert_eq!(error("return 79228162514264337593543950335 * 10;").code, "VKS4005");
}

#[test]
fn no_truthiness_and_no_silent_coercion() {
    assert_eq!(error("if 1 { return 1; }").code, "VKS4002");
    assert_eq!(error("let x = null; while x { }").code, "VKS4002");
    assert_eq!(error("return !0;").code, "VKS4002");
    assert_eq!(error("return true && 1;").code, "VKS4002");
    let e = error("return \"Total: \" + 5;");
    assert_eq!(e.code, "VKS4001");
    assert!(e.message.contains("str(x)"), "{}", e.message);
    assert_eq!(e.kind, "type");
    assert_eq!((e.line, e.col), (1, 8));
    // Short-circuit: the right side is not evaluated.
    assert_eq!(value("return false && 1 / 0 == 1;"), WireValue::Bool(false));
}

#[test]
fn equality_and_ordering_rules() {
    assert_eq!(value("return 1 == \"1\";"), WireValue::Bool(false));
    assert_eq!(value("return 1 == 1.0;"), WireValue::Bool(true));
    assert_eq!(value("return null == null;"), WireValue::Bool(true));
    assert_eq!(value("return null != 0;"), WireValue::Bool(true));
    assert_eq!(value("let a = [1]; let b = [1]; return [a == b, a == a];"), WireValue::Array(vec![WireValue::Bool(false), WireValue::Bool(true)]));
    assert_eq!(value("return \"apple\" < \"banana\";"), WireValue::Bool(true));
    assert_eq!(value("return date(\"2026-01-01\") < date(\"2026-02-01\");"), WireValue::Bool(true));
    assert_eq!(error("return 1 < \"2\";").code, "VKS4013");
    assert_eq!(error("return null < 1;").code, "VKS4013");
}

#[test]
fn rounding_is_explicit() {
    assert_eq!(value("return round(2.345, 2);"), dec("2.35"));
    assert_eq!(value("return round(-2.345, 2);"), dec("-2.35"));
    assert_eq!(value("return round(2.345, 2, \"even\");"), dec("2.34"));
    assert_eq!(value("return round(2.5);"), dec("3"));
    assert_eq!(value("return (2.675).round(2);"), dec("2.68"));
    assert_eq!(value("return round(7, 2);"), int(7));
    assert_eq!(error("return round(1.5, -1);").code, "VKS4011");
    assert_eq!(error("return round(1.5, 2, \"up\");").code, "VKS4011");
}

#[test]
fn conversions_are_explicit_and_checked() {
    assert_eq!(value("return str(12.50) + \" USD\";"), text("12.50 USD"));
    assert_eq!(value("return int(\" 42 \");"), int(42));
    assert_eq!(value("return int(5.0);"), int(5));
    assert_eq!(error("return int(5.5);").code, "VKS4012");
    assert_eq!(error("return int(\"4x\");").code, "VKS4012");
    assert_eq!(value("return decimal(\"1.005\");"), dec("1.005"));
    assert_eq!(error("return decimal(\"1e5\");").code, "VKS4012");
    assert_eq!(value("return bool(\"true\");"), WireValue::Bool(true));
    assert_eq!(error("return bool(\"yes\");").code, "VKS4012");
    assert_eq!(value("return typeOf(1.0) + \"/\" + typeOf([]) + \"/\" + typeOf({}) + \"/\" + typeOf(null);"), text("Decimal/Array/Map/Null"));
}

#[test]
fn collections() {
    assert_eq!(
        value("let a = [1, 2]; a.add(3); a[0] = 10; return [a.count(), a[0], a.last(), a.contains(2), a.indexOf(9)];"),
        WireValue::Array(vec![int(3), int(10), int(3), WireValue::Bool(true), int(-1)])
    );
    assert_eq!(error("let a = [1, 2, 3]; return a[3];").code, "VKS4006");
    assert_eq!(error("let a = [1]; return a[-1];").code, "VKS4006");
    assert_eq!(error("let a = [1]; return a[\"0\"];").code, "VKS4007");
    assert_eq!(
        value("let m = { name: \"Motor\", \"two words\": 2 }; m.price = 5; return [m.name, m[\"two words\"], m.missing, m.has(\"price\"), m.keys()];"),
        WireValue::Array(vec![text("Motor"), int(2), WireValue::Null, WireValue::Bool(true), WireValue::Array(vec![text("name"), text("two words"), text("price")])])
    );
    assert_eq!(value("let a = [3, 1, 2]; a.sort(); return a.join(\",\");"), text("1,2,3"));
    assert_eq!(error("let a = [3, \"x\"]; a.sort();").code, "VKS4013");
    assert_eq!(value("return [1.5, 2, 0.25].sum();"), dec("3.75"));
    assert_eq!(value("let m = {}; for i in range(20) { m[str(i)] = i; } m.remove(\"3\"); return [m.count(), m.get(\"19\"), m.get(\"3\", -1)];"), WireValue::Array(vec![int(19), int(19), int(-1)]));
    assert_eq!(error("let x = null; return x.name;").code, "VKS4008");
}

#[test]
fn strings() {
    assert_eq!(value("return \"Hello, World\".upper();"), text("HELLO, WORLD"));
    assert_eq!(value("return \"  pad \".trim().length();"), int(3));
    assert_eq!(value("return \"héllo\".substring(1, 3);"), text("él"));
    assert_eq!(value("return \"a,b,c\".split(\",\").count();"), int(3));
    assert_eq!(value("return \"abcabc\".replace(\"b\", \"X\");"), text("aXcaXc"));
    assert_eq!(value("return \"日本語\".indexOf(\"語\");"), int(2));
    assert_eq!(value("return format(\"{0} x {1} = {{{2}}}\", 3, 1.50, 4.50);"), text("3 x 1.50 = {4.50}"));
    assert_eq!(error("return format(\"{1}\", 1);").code, "VKS4011");
    assert_eq!(error("return \"abc\".substring(2, 9);").code, "VKS4006");
}

#[test]
fn dates_durations_and_money() {
    assert_eq!(value("return date(\"2026-10-28\") + days(3);"), WireValue::Date("2026-10-31".into()));
    assert_eq!(value("return (date(\"2026-03-01\") - date(\"2026-02-01\")).totalSeconds();"), int(28 * 86_400));
    assert_eq!(value("return date(2026, 1, 31).addMonths(1);"), WireValue::Date("2026-02-28".into()));
    assert_eq!(value("return date(\"2026-02-10\").endOfMonth();"), WireValue::Date("2026-02-28".into()));
    assert_eq!(value("return dateTime(\"2026-10-28T14:30:00+02:00\") + hours(1);"), WireValue::DateTime("2026-10-28T13:30:00Z".into()));
    assert_eq!(value("return today();"), WireValue::Date("2026-10-28".into()));
    assert_eq!(value("return str(days(1) + hours(2));"), text("1d 2h"));
    assert_eq!(error("return date(\"2026-10-28\") + hours(5);").code, "VKS4017");
    assert_eq!(error("return date(\"2026-02-30\");").code, "VKS4012");
    assert_eq!(value("return money(10.25, \"USD\") * 3;"), WireValue::Money { amount: "30.75".into(), currency: "USD".into() });
    assert_eq!(value("let m = money(100, \"EUR\"); return [m.amount, m.currency];"), WireValue::Array(vec![dec("100"), text("EUR")]));
    assert_eq!(error("return money(1, \"USD\") + money(1, \"EUR\");").code, "VKS4016");
    assert_eq!(error("return money(1, \"USD\") * money(1, \"USD\");").code, "VKS4001");
    assert_eq!(error("return money(1, \"usd\");").code, "VKS4012");
}

#[test]
fn control_flow_and_scoping() {
    assert_eq!(value("let s = 0; for i in range(1, 11) { if i % 2 == 0 { continue; } if i > 7 { break; } s += i; } return s;"), int(16));
    assert_eq!(value("let n = 0; while n < 5 { n += 1; } return n;"), int(5));
    assert_eq!(value("let keys = \"\"; let m = { a: 1, b: 2 }; for k in m { keys += k; } return keys;"), text("ab"));
    // A map literal cannot start a loop header: `{` there opens the body.
    assert!(compile("for k in { a: 1 } { }", Options { allow_script: true }).0.is_none());
    assert_eq!(value("let x = 1; if true { let x = 2; x += 1; } return x;"), int(1));
    assert_eq!(value("let total = 0; for x in [1.5, 2.5] { total += x; } return total;"), dec("4.0"));
    assert_eq!(error("for x in 5 { }").code, "VKS4020");
}

#[test]
fn functions_recursion_and_named_arguments() {
    assert_eq!(value("function fact(n) { if n <= 1 { return 1; } return n * fact(n - 1); } return fact(20);"), int(2_432_902_008_176_640_000));
    assert_eq!(value("function f(a, b) { return a - b; } return f(b: 1, a: 5);"), int(4));
    assert_eq!(value("function f(a, b) { return a - b; } let g = f; return g(3, 1);"), int(2));
    assert_eq!(value("function nothing() { } return nothing();"), WireValue::Null);
    assert_eq!(value("return later(2); function later(x) { return x * 10; }"), int(20));
    let e = error("function f(a, b) { return a; } let g = f; return g(1);");
    assert_eq!(e.code, "VKS4011");
}

#[test]
fn semantic_errors_are_found_before_running() {
    assert!(semantic("return missing + 1;").contains(&"VKS3001"));
    assert!(semantic("let a = 1; let a = 2;").contains(&"VKS3002"));
    assert!(semantic("x = 5;").contains(&"VKS3003"));
    assert!(semantic("let a = 1; if true { let b = 2; } return b;").contains(&"VKS3001"));
    assert!(semantic("break;").contains(&"VKS3005"));
    assert!(semantic("function str(x) { }").contains(&"VKS3006"));
    assert!(semantic("function f(a, a) { }").contains(&"VKS3007"));
    assert!(semantic("function f(a) { } f(1, 2);").contains(&"VKS3008"));
    assert!(semantic("function f(a) { } f(b: 1);").contains(&"VKS3008"));
    assert!(semantic("round();").contains(&"VKS3008"));
    assert!(semantic("let f = 1; str = 2;").contains(&"VKS3018"));
    assert!(semantic("1 + 1 = 3;").contains(&"VKS3004") || semantic("1 + 1 = 3;").iter().any(|c| c.starts_with("VKS11")));
    let (_, d) = compile("let x = 1;", Options { allow_script: false });
    assert!(d.iter().any(|d| d.code == "VKS3019"));
}

#[test]
fn limits_stop_runaway_scripts() {
    let small = Limits { max_steps: 10_000, ..Limits::default() };
    let e = limit_error("while true { }", small.clone());
    assert_eq!((e.code.as_str(), e.kind.as_str()), ("VKS4200", "limit"));
    assert_eq!(limit_error("function f(n) { return f(n + 1); } return f(0);", Limits::default()).code, "VKS4202");
    let tiny = Limits { max_collection_len: 100, ..Limits::default() };
    assert_eq!(limit_error("let a = []; for i in range(1000) { a.add(i); }", tiny.clone()).code, "VKS4203");
    assert_eq!(limit_error("return range(101);", tiny).code, "VKS4203");
    let strings = Limits { max_string_bytes: 1000, ..Limits::default() };
    assert_eq!(limit_error("let s = \"x\"; while true { s = s + s; }", strings).code, "VKS4204");
    let memory = Limits { max_memory_bytes: 100_000, ..Limits::default() };
    assert_eq!(limit_error("let a = []; for i in range(100000) { a.add(\"item \" + str(i)); }", memory).code, "VKS4205");
    let time = Limits { max_millis: 50, max_steps: u64::MAX, ..Limits::default() };
    assert_eq!(limit_error("while true { }", time).code, "VKS4201");
}

#[test]
fn errors_carry_positions() {
    let e = error("let a = 1;\nlet b = [1, 2];\nreturn b[a + 5];");
    assert_eq!((e.code.as_str(), e.line), ("VKS4006", 3));
    let e = error("function check(q) {\n    if q <= 0 { reject(\"Quantity must be positive.\"); }\n    return q;\n}\nreturn check(0);");
    assert_eq!((e.code.as_str(), e.kind.as_str(), e.line, e.message.as_str()), ("VKS4100", "rejected", 2, "Quantity must be positive."));
}

#[test]
fn logs_and_context() {
    let r = run_with("notify(\"Hello \" + Context.user); log(\"detail\"); return Context.can(\"catalog.read\");", Limits::default());
    assert!(r.ok);
    assert_eq!(r.value, Some(WireValue::Bool(true)));
    assert_eq!(r.logs.iter().map(|l| (l.level.as_str(), l.message.as_str())).collect::<Vec<_>>(), [("notify", "Hello tester"), ("info", "detail")]);
}

#[test]
fn scripts_have_no_ambient_authority() {
    // Nothing reaches the outside world without the platform: with no host attached, any
    // business operation fails cleanly.
    let e = error("catalog P { field code: String(10); } return Catalog.P.findByCode(\"x\");");
    assert_eq!(e.code, "VKS4404");
    // There is no syntax or built-in for files, processes, network or environment.
    for name in ["open", "exec", "system", "fetch", "require", "import", "eval", "env", "readFile"] {
        assert!(semantic(&format!("{name}(\"x\");")).contains(&"VKS3001"), "{name} must not exist");
    }
}

#[test]
fn the_language_tour_example_runs() {
    let r = run_with(include_str!("../../../examples/tour.vks"), Limits::default());
    assert!(r.ok, "{:?}", r.error);
    let WireValue::Map(entries) = r.value.unwrap() else { panic!("tour returns a map") };
    assert_eq!(entries[0], ("total".to_string(), dec("126.25")));
    assert_eq!(r.logs.len(), 7);
}
