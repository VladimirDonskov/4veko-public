//! `vks bench`: repeatable micro-benchmarks of the engine. Numbers depend on the machine and
//! build profile; run with `cargo run --release -p vks-cli -- bench`.

use std::process::ExitCode;
use std::rc::Rc;
use std::time::Instant;
use vks_protocol::{Entry, Envelope, ExecuteResult, Limits, Message};
use vks_runtime::{check, execute, with_engine_stack, MemoryHost, NoHost, Options};

const INVENTORY: &str = include_str!("../../../examples/inventory.vks");

struct Row {
    name: &'static str,
    iterations: u64,
    total_ms: f64,
    unit: &'static str,
    per_unit: f64,
}

fn time<F: FnMut()>(iterations: u64, mut f: F) -> f64 {
    let start = Instant::now();
    for _ in 0..iterations {
        f();
    }
    start.elapsed().as_secs_f64() * 1000.0
}

fn script(src: &str) -> f64 {
    let out = check(src, Options { allow_script: true });
    let program = out.program.expect("benchmark script compiles");
    let mut ctx = crate::local_context(&["*"]);
    ctx.limits = Limits { max_steps: u64::MAX, max_millis: 600_000, ..Limits::default() };
    let start = Instant::now();
    let r = execute(&program, &ctx, &Entry::Script, &mut NoHost);
    assert!(r.ok, "{:?}", r.error);
    start.elapsed().as_secs_f64() * 1000.0
}

pub fn run(quick: bool) -> Result<ExitCode, String> {
    let scale: u64 = if quick { 10 } else { 1 };
    let rows = with_engine_stack(move || {
        let mut rows = Vec::new();

        let n = 2_000 / scale;
        let ms = time(n, || {
            let out = check(INVENTORY, Options::default());
            assert!(out.program.is_some());
        });
        rows.push(Row { name: "check inventory.vks (parse + metadata + analysis)", iterations: n, total_ms: ms, unit: "µs/check", per_unit: ms * 1000.0 / n as f64 });

        let loops = 1_000_000 / scale;
        let ms = script(&format!("let s = 0; for i in range({loops}) {{ s += i; }} return s;"));
        rows.push(Row { name: "integer loop (s += i)", iterations: loops, total_ms: ms, unit: "ns/iteration", per_unit: ms * 1e6 / loops as f64 });

        let decs = 200_000 / scale;
        let ms = script(&format!("let t = 0.00; for i in range({decs}) {{ t += round(1.15 * 3.333, 2); }} return t;"));
        rows.push(Row { name: "decimal multiply + round + add", iterations: decs, total_ms: ms, unit: "ns/iteration", per_unit: ms * 1e6 / decs as f64 });

        let fib = if quick { 18 } else { 24 };
        let calls: u64 = {
            let (mut a, mut b) = (1u64, 1u64);
            for _ in 0..fib {
                let c = a + b + 1;
                a = b;
                b = c;
            }
            a
        };
        let ms = script(&format!("function fib(n) {{ if n < 2 {{ return n; }} return fib(n - 1) + fib(n - 2); }} return fib({fib});"));
        rows.push(Row { name: "recursive calls (fib)", iterations: calls, total_ms: ms, unit: "ns/call", per_unit: ms * 1e6 / calls as f64 });

        let strs = 100_000 / scale;
        let ms = script(&format!("let m = {{}}; for i in range({strs}) {{ m[\"k\" + str(i % 1000)] = i; }} return m.count();"));
        rows.push(Row { name: "string keys into a map", iterations: strs, total_ms: ms, unit: "ns/iteration", per_unit: ms * 1e6 / strs as f64 });

        // Posting through the in-memory platform: save, BeforeSave, BeforePost, Post handler,
        // intent validation, movements, AfterPost.
        let docs = 1_000 / scale;
        let src = format!(
            "{INVENTORY}\n{}",
            r#"
            let p = Catalog.Products.create(code: "P-1", name: "Motor"); p.save();
            let w = Catalog.Warehouses.create(code: "W", name: "Main"); w.save();
            let s = Catalog.Suppliers.create(code: "S", name: "Acme"); s.save();
            let n = int(Context.operation);
            for i in range(n) {
                let r = Document.GoodsReceipt.create(warehouse: w, supplier: s);
                r.items.add(product: p, quantity: 2, unitPrice: 10.00);
                r.items.add(product: p, quantity: 1.5, unitPrice: 4.00);
                r.post();
            }
            return Register.StockBalance.balance(product: p).quantity;
            "#
        );
        let out = check(&src, Options { allow_script: true });
        let program = Rc::new(out.program.expect("posting benchmark compiles"));
        let mut host = MemoryHost::new(program.clone());
        let mut ctx = crate::local_context(&["*"]);
        ctx.operation = docs.to_string();
        ctx.limits = Limits { max_steps: u64::MAX, max_millis: 600_000, max_host_calls: u32::MAX, max_queries: u32::MAX, ..Limits::default() };
        let start = Instant::now();
        let r = execute(&program, &ctx, &Entry::Script, &mut host);
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(r.ok, "{:?}", r.error);
        rows.push(Row { name: "post GoodsReceipt (2 lines, in-memory platform)", iterations: docs, total_ms: ms, unit: "µs/document", per_unit: ms * 1000.0 / docs as f64 });

        // Protocol encoding of a typical posting result.
        let sample = Envelope::new(
            7,
            Message::ExecuteResult(ExecuteResult {
                ok: true,
                value: None,
                object: None,
                intents: host
                    .movements()
                    .iter()
                    .take(2)
                    .map(|m| vks_protocol::Intent::RegisterMovement { register: m.register.clone(), direction: m.direction, dimensions: m.dimensions.clone(), measures: m.measures.clone() })
                    .collect(),
                logs: Vec::new(),
                error: None,
                stats: Default::default(),
            }),
        );
        let msgs = 20_000 / scale;
        let ms = time(msgs, || {
            let line = serde_json::to_string(&sample).expect("encodes");
            let back: Envelope = serde_json::from_str(&line).expect("decodes");
            assert_eq!(back.id, 7);
        });
        rows.push(Row { name: "vks/1 envelope encode + decode (2 intents)", iterations: msgs, total_ms: ms, unit: "µs/message", per_unit: ms * 1000.0 / msgs as f64 });
        rows
    });

    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    println!("VekoScript benchmarks ({profile} build, {} {}){}", std::env::consts::OS, std::env::consts::ARCH, if quick { ", quick" } else { "" });
    println!("{:<52} {:>12} {:>12} {:>16}", "benchmark", "iterations", "total ms", "per unit");
    for r in rows {
        println!("{:<52} {:>12} {:>12.1} {:>10.2} {}", r.name, r.iterations, r.total_ms, r.per_unit, r.unit);
    }
    Ok(ExitCode::SUCCESS)
}
