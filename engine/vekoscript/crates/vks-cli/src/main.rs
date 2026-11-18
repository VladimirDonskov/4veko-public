//! `vks`: the VekoScript command-line tool and isolated execution worker.

mod bench;
mod sandbox;
mod worker;

use std::path::Path;
use std::process::ExitCode;
use std::rc::Rc;
use vks_protocol::{Entry, ExecContext, Limits};
use vks_runtime::{check, execute, with_engine_stack, MemoryHost, Options};

const USAGE: &str = "\
vks — VekoScript tool

USAGE:
  vks check <file.vks> [--json] [--script]   Check syntax, metadata and logic
  vks metadata <file.vks>                    Print the metadata model as JSON
  vks plan <file.vks> [--from <old.vks>]     Print the storage migration plan as JSON
  vks run <file.vks> [--function <name>] [--json]
                                             Run a script (or one function) against an
                                             in-memory platform
  vks worker [--max-memory-mb <n>]           Serve the vks/1 protocol on stdin/stdout
  vks bench [--quick]                        Run the built-in benchmarks
  vks version
";

fn read(path: &str) -> Result<String, String> {
    std::fs::read_to_string(Path::new(path)).map_err(|e| format!("Cannot read {path}: {e}"))
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn print_diagnostics(path: &str, diags: &[vks_syntax::Diagnostic]) {
    for d in diags {
        eprintln!("{path}:{d}");
    }
}

pub fn local_context(capabilities: &[&str]) -> ExecContext {
    use chrono::Timelike;
    let now = chrono::Utc::now().naive_utc().with_nanosecond(0).expect("valid time");
    ExecContext {
        organization: "local".into(),
        user: "developer".into(),
        application: "local".into(),
        script_version: 1,
        capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
        operation: "vks run".into(),
        now: now.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        correlation_id: "local".into(),
        event_depth: 0,
        limits: Limits::default(),
    }
}

fn cmd_check(args: &[String]) -> Result<ExitCode, String> {
    let path = args.first().ok_or("vks check needs a file")?;
    let src = read(path)?;
    let out = check(&src, Options { allow_script: flag(args, "--script") });
    let failed = vks_syntax::has_errors(&out.diagnostics);
    if flag(args, "--json") {
        let json = serde_json::json!({
            "ok": !failed,
            "diagnostics": vks_runtime::wire_diagnostics(&out.diagnostics),
            "handlers": out.handlers,
        });
        println!("{}", serde_json::to_string_pretty(&json).expect("serializes"));
    } else {
        print_diagnostics(path, &out.diagnostics);
        if !failed {
            let m = out.metadata.unwrap_or_default();
            let p = out.program.as_ref();
            println!(
                "{path}: ok — {} catalog(s), {} document(s), {} register(s), {} function(s), {} handler(s)",
                m.catalogs.len(),
                m.documents.len(),
                m.registers.len(),
                p.map(|p| p.functions.len()).unwrap_or(0),
                p.map(|p| p.handlers.len()).unwrap_or(0)
            );
        }
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

fn cmd_metadata(args: &[String]) -> Result<ExitCode, String> {
    let path = args.first().ok_or("vks metadata needs a file")?;
    let (model, diags) = vks_metadata::from_source(&read(path)?);
    if vks_syntax::has_errors(&diags) {
        print_diagnostics(path, &diags);
        return Ok(ExitCode::FAILURE);
    }
    println!("{}", serde_json::to_string_pretty(&model).expect("serializes"));
    Ok(ExitCode::SUCCESS)
}

fn cmd_plan(args: &[String]) -> Result<ExitCode, String> {
    let path = args.first().ok_or("vks plan needs a file")?;
    let (new, diags) = vks_metadata::from_source(&read(path)?);
    if vks_syntax::has_errors(&diags) {
        print_diagnostics(path, &diags);
        return Ok(ExitCode::FAILURE);
    }
    let old = match option(args, "--from") {
        Some(p) => {
            let (m, d) = vks_metadata::from_source(&read(p)?);
            if vks_syntax::has_errors(&d) {
                print_diagnostics(p, &d);
                return Ok(ExitCode::FAILURE);
            }
            Some(m)
        }
        None => None,
    };
    let plan = vks_metadata::plan_migration(old.as_ref(), &new);
    println!("{}", serde_json::to_string_pretty(&plan).expect("serializes"));
    Ok(ExitCode::SUCCESS)
}

fn cmd_run(args: &[String]) -> Result<ExitCode, String> {
    let path = args.first().ok_or("vks run needs a file")?.clone();
    let src = read(&path)?;
    let function = option(args, "--function").map(str::to_string);
    let json = flag(args, "--json");
    with_engine_stack(move || {
        let out = check(&src, Options { allow_script: true });
        print_diagnostics(&path, &out.diagnostics);
        let Some(program) = out.program else {
            return Ok(ExitCode::FAILURE);
        };
        let program = Rc::new(program);
        let mut host = MemoryHost::new(program.clone());
        let entry = match function {
            Some(name) => Entry::Function { name, args: Vec::new() },
            None => Entry::Script,
        };
        let r = execute(&program, &local_context(&["*"]), &entry, &mut host);
        if json {
            println!("{}", serde_json::to_string_pretty(&r).expect("serializes"));
        } else {
            for l in &r.logs {
                println!("[{}] {}", l.level, l.message);
            }
            for n in &host.notifications {
                println!("[after-commit] {n}");
            }
            match (&r.error, &r.value) {
                (Some(e), _) => eprintln!("{path}:{}:{}: {} error [{}] {}", e.line, e.col, e.kind, e.code, e.message),
                (None, Some(v)) => {
                    let shown = vks_runtime::convert::wire_to_value(v, &program.metadata).map(|v| v.display()).unwrap_or_else(|_| format!("{v:?}"));
                    println!("=> {shown}");
                }
                (None, None) => {}
            }
            eprintln!("({} steps, {} platform calls, {} µs; {} movement(s) in memory)", r.stats.steps, r.stats.host_calls, r.stats.micros, host.movements().len());
        }
        Ok(if r.ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
    })
}

fn cmd_worker(args: &[String]) -> Result<ExitCode, String> {
    let mb: usize = option(args, "--max-memory-mb").map(|v| v.parse().map_err(|_| "--max-memory-mb takes a number")).transpose()?.unwrap_or(512);
    match sandbox::apply(mb * 1024 * 1024) {
        Ok(what) => eprintln!("vks worker: {what}"),
        Err(why) => eprintln!("vks worker: running without operating-system limits ({why})"),
    }
    with_engine_stack(|| {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let mut w = worker::Worker::new(stdin.lock(), stdout.lock());
        w.run().map_err(|e| format!("worker I/O failed: {e}"))
    })?;
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let rest = &args[1..];
    let r = match cmd.as_str() {
        "check" => cmd_check(rest),
        "metadata" => cmd_metadata(rest),
        "plan" => cmd_plan(rest),
        "run" => cmd_run(rest),
        "worker" => cmd_worker(rest),
        "bench" => bench::run(flag(rest, "--quick")),
        "version" | "--version" => {
            println!("vks {} (protocol {})", env!("CARGO_PKG_VERSION"), vks_protocol::PROTOCOL);
            Ok(ExitCode::SUCCESS)
        }
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("Unknown command \"{other}\".\n\n{USAGE}")),
    };
    r.unwrap_or_else(|e| {
        eprintln!("{e}");
        ExitCode::FAILURE
    })
}
