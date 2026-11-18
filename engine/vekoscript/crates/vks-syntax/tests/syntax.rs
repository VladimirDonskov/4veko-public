use rust_decimal::Decimal;
use std::str::FromStr;
use vks_syntax::ast::*;
use vks_syntax::lexer::{tokenize, Tok};
use vks_syntax::{has_errors, parse};

fn ok(src: &str) -> Module {
    let r = parse(src);
    assert!(!has_errors(&r.diagnostics), "unexpected diagnostics: {:#?}", r.diagnostics);
    r.module
}

fn first_expr(src: &str) -> Expr {
    match ok(src).items.into_iter().next() {
        Some(Item::Stmt(Stmt::Expr { expr, .. })) => expr,
        other => panic!("not an expression statement: {other:?}"),
    }
}

/// Render an expression with explicit parentheses to check precedence.
fn show(e: &Expr) -> String {
    match &e.kind {
        ExprKind::Int(i) => i.to_string(),
        ExprKind::Decimal(d) => d.to_string(),
        ExprKind::Ident(n) => n.clone(),
        ExprKind::Str(s) => format!("{s:?}"),
        ExprKind::Bool(b) => b.to_string(),
        ExprKind::Null => "null".into(),
        ExprKind::Binary { op, left, right } => format!("({} {} {})", show(left), op.symbol(), show(right)),
        ExprKind::Unary { op, expr } => format!("({}{})", if *op == UnaryOp::Neg { "-" } else { "!" }, show(expr)),
        ExprKind::Member { object, name } => format!("{}.{}", show(object), name),
        ExprKind::Index { object, index } => format!("{}[{}]", show(object), show(index)),
        ExprKind::Call { callee, args } => format!(
            "{}({})",
            show(callee),
            args.iter()
                .map(|a| match &a.name {
                    Some(n) => format!("{n}: {}", show(&a.value)),
                    None => show(&a.value),
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        ExprKind::Array(items) => format!("[{}]", items.iter().map(show).collect::<Vec<_>>().join(", ")),
        ExprKind::Map(entries) => format!("{{{}}}", entries.iter().map(|(k, v)| format!("{k}: {}", show(v))).collect::<Vec<_>>().join(", ")),
    }
}

#[test]
fn lexer_tracks_lines_and_columns() {
    let (tokens, diags) = tokenize("let x = 10;\n  total += 2.50; // comment\n\"a\\tb\"");
    assert!(diags.is_empty());
    let total = tokens.iter().find(|t| t.tok == Tok::Ident("total".into())).unwrap();
    assert_eq!((total.span.line, total.span.col), (2, 3));
    assert!(tokens.iter().any(|t| t.tok == Tok::Decimal("2.50".into())));
    assert!(tokens.iter().any(|t| t.tok == Tok::PlusAssign));
    assert!(tokens.iter().any(|t| t.tok == Tok::Str("a\tb".into())));
}

#[test]
fn lexer_reports_bad_input_and_keeps_going() {
    let (_, diags) = tokenize("let a = 1 @ 2; \"open\nlet b = 3abc;");
    let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
    assert!(codes.contains(&"VKS1001"), "{codes:?}"); // @
    assert!(codes.contains(&"VKS1003"), "{codes:?}"); // unclosed string
    assert!(codes.contains(&"VKS1002"), "{codes:?}"); // 3abc
}

#[test]
fn operator_precedence() {
    assert_eq!(show(&first_expr("1 + 2 * 3 - 4 / 2;")), "((1 + (2 * 3)) - (4 / 2))");
    assert_eq!(show(&first_expr("a || b && !c == d < e + -f;")), "(a || (b && ((!c) == (d < (e + (-f))))))");
    assert_eq!(show(&first_expr("(1 + 2) * 3;")), "((1 + 2) * 3)");
    assert_eq!(show(&first_expr("-5 % 3;")), "(-5 % 3)");
}

#[test]
fn postfix_calls_members_indexes_and_named_arguments() {
    let e = first_expr("Catalog.Products.findByCode(\"C-001\").price;");
    assert_eq!(show(&e), "Catalog.Products.findByCode(\"C-001\").price");
    let e = first_expr("receipt.items.add(product: p, quantity: 10, unitPrice: 250.00,);");
    assert_eq!(show(&e), "receipt.items.add(product: p, quantity: 10, unitPrice: 250.00)");
    assert_eq!(show(&first_expr("m[\"k\"][0];")), "m[\"k\"][0]");
}

#[test]
fn decimals_are_exact_and_negative_literals_fold() {
    match first_expr("150.00;").kind {
        ExprKind::Decimal(d) => {
            assert_eq!(d, Decimal::from_str("150.00").unwrap());
            assert_eq!(d.scale(), 2);
        }
        k => panic!("{k:?}"),
    }
    assert_eq!(first_expr("-9223372036854775808;").kind, ExprKind::Int(i64::MIN));
}

#[test]
fn statements_and_blocks() {
    let m = ok(r#"
        let total = 0;
        for line in lines {
            if line.qty > 0 { total += line.qty; } else if line.qty == 0 { continue; } else { break; }
        }
        while total > 10 { total -= 1; }
        function f(a, b) { return a + b; }
        function g() { return; }
    "#);
    assert_eq!(m.items.len(), 5);
    assert!(matches!(m.items[1], Item::Stmt(Stmt::For { .. })));
    assert!(matches!(&m.items[3], Item::Function(f) if f.params == vec!["a", "b"]));
}

#[test]
fn maps_and_blocks_are_not_confused() {
    let m = ok("let m = { name: \"A\", \"two words\": 2 }; if ready { notify(m); }");
    assert!(matches!(&m.items[0], Item::Stmt(Stmt::Let { value: Expr { kind: ExprKind::Map(e), .. }, .. }) if e.len() == 2));
    assert!(matches!(&m.items[1], Item::Stmt(Stmt::If { .. })));
}

#[test]
fn metadata_declarations() {
    let m = ok(r#"
        catalog Products {
            field code: String(20) required unique;
            field name: String required;
            field price: Decimal(18, 2) default 0.00;
            field active: Boolean default true;
        }
        document GoodsReceipt {
            field warehouse: Ref<Warehouses> required;
            rows items {
                field product: Ref<Products> required;
                field quantity: Decimal(18, 3);
            }
        }
        register StockBalance {
            dimension product: Ref<Products>;
            measure quantity: Decimal(18, 3);
        }
        information register ProductPrices periodic {
            dimension product: Ref<Products>;
            resource price: Decimal(18, 2);
        }
    "#);
    let Item::Catalog(c) = &m.items[0] else { panic!() };
    assert_eq!(c.fields[0].ty, TypeRef::String(Some(20)));
    assert!(c.fields[0].required && c.fields[0].unique);
    assert_eq!(c.fields[2].ty, TypeRef::Decimal(18, 2));
    assert_eq!(c.fields[3].default, Some(Literal::Bool(true)));
    let Item::Document(d) = &m.items[1] else { panic!() };
    assert_eq!(d.rows[0].name, "items");
    assert_eq!(d.rows[0].fields[0].ty, TypeRef::Ref("Products".into()));
    let Item::Register(r) = &m.items[3] else { panic!() };
    assert_eq!(r.kind, RegisterKind::Information { periodic: true });
}

#[test]
fn event_handlers() {
    let m = ok("on GoodsReceipt.BeforePost(document) { if document.items.count() == 0 { reject(\"Cannot post an empty receipt\"); } }");
    let Item::Handler(h) = &m.items[0] else { panic!() };
    assert_eq!((h.target.as_str(), h.event, h.param.as_str()), ("GoodsReceipt", Event::BeforePost, "document"));
    let bad = parse("on GoodsReceipt.Posted(d) { }");
    assert_eq!(bad.diagnostics[0].code, "VKS1109");
}

#[test]
fn recovers_and_reports_several_errors() {
    let r = parse("let a = ;\nlet b = 2;\ncatalog X {\n  field n Text;\n  field ok: String;\n}\nfunction f( { }\nlet c = 3;");
    let lines: Vec<u32> = r.diagnostics.iter().map(|d| d.span.line).collect();
    assert!(lines.contains(&1), "{:#?}", r.diagnostics);
    assert!(lines.contains(&4), "{:#?}", r.diagnostics);
    assert!(lines.contains(&7), "{:#?}", r.diagnostics);
    // Valid parts are still parsed.
    assert!(r.module.items.iter().any(|i| matches!(i, Item::Stmt(Stmt::Let { name, .. }) if name == "c")));
    assert!(r.module.items.iter().any(|i| matches!(i, Item::Catalog(c) if c.fields.iter().any(|f| f.name == "ok"))));
}

#[test]
fn rejects_misplaced_and_ambiguous_constructs() {
    assert_eq!(parse("{ let a = 1; }").diagnostics[0].code, "VKS1110");
    assert_eq!(parse("function f() { catalog X { } }").diagnostics[0].code, "VKS1111");
    assert_eq!(parse("1 + 2 = 3;").diagnostics[0].code, "VKS1112");
    assert_eq!(parse("f(a: 1, 2);").diagnostics[0].code, "VKS1115");
    assert_eq!(parse("register R periodic { }").diagnostics[0].code, "VKS1108");
    assert_eq!(parse("catalog C { field x: Money; }").diagnostics[0].code, "VKS1105");
}

#[test]
fn deeply_nested_input_is_refused_without_crashing() {
    let src = format!("let x = {}1{};", "(".repeat(5000), ")".repeat(5000));
    let r = parse(&src);
    assert!(r.diagnostics.iter().any(|d| d.code == "VKS1199"));
    let src = format!("let x = {}1;", "-".repeat(5000));
    assert!(parse(&src).diagnostics.iter().any(|d| d.code == "VKS1199"));
}

#[test]
fn fuzz_like_inputs_never_panic() {
    // A cheap deterministic fuzz: every prefix and some byte mutations of a valid program.
    let base = "catalog P { field c: String(5) required; } on P.BeforeSave(o) { if o.c == \"x\" { reject(\"no\"); } } let a = [1, {k: 2.5}]; a[0] += 1;";
    for i in 0..base.len() {
        if base.is_char_boundary(i) {
            let _ = parse(&base[..i]);
        }
    }
    let bytes = base.as_bytes();
    let mut seed: u64 = 42;
    for _ in 0..2000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut v = bytes.to_vec();
        let pos = (seed >> 33) as usize % v.len();
        v[pos] = b"{}()[];:,.\"=+-*/!<>&| a1"[(seed >> 13) as usize % 24];
        if let Ok(s) = String::from_utf8(v) {
            let _ = parse(&s);
        }
    }
}
