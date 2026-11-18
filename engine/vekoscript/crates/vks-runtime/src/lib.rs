//! VekoScript runtime: semantic analysis against metadata and a sandboxed interpreter.
//!
//! The runtime has no access to files, processes, the network, environment variables or the
//! database. Everything a script does to business data goes through [`Host`] as a typed
//! request that the platform authorizes and applies.

pub mod builtins;
pub mod compile;
pub mod convert;
pub mod error;
mod interp;
pub mod memory_host;
pub mod ops;
mod stdlib;
pub mod value;

pub use compile::{compile, Options, Program};
pub use error::{codes, RtError};
pub use interp::{with_engine_stack, Host, NoHost, ENGINE_STACK_SIZE, STACK_BUDGET};
pub use memory_host::MemoryHost;

use convert::{obj_from_wire, obj_to_wire, value_to_wire, wire_to_value};
use interp::{Arg, Interp};
use value::{Lock, LockReason, Value};
use vks_metadata::MetadataModel;
use vks_protocol::{Entry, ExecContext, ExecError, ExecuteResult, HandlerInfo, Stats, WireDiagnostic};
use vks_syntax::ast::Event;
use vks_syntax::{Diagnostic, Kind, Span};

/// Result of checking a source file.
pub struct CheckOutput {
    pub diagnostics: Vec<Diagnostic>,
    /// The metadata when it has no errors (logic errors do not hide valid metadata).
    pub metadata: Option<MetadataModel>,
    pub handlers: Vec<HandlerInfo>,
    pub program: Option<Program>,
}

/// Parse, validate metadata and analyze logic. Never runs code.
pub fn check(source: &str, options: Options) -> CheckOutput {
    let (program, diagnostics) = compile(source, options);
    let metadata_ok = !diagnostics.iter().any(|d| matches!(d.kind, Kind::Syntax | Kind::Metadata));
    let metadata = if metadata_ok {
        match &program {
            Some(p) => Some((*p.metadata).clone()),
            None => {
                let (m, _) = vks_metadata::from_source(source);
                Some(m)
            }
        }
    } else {
        None
    };
    let handlers = program.as_ref().map(|p| p.handlers.iter().map(|h| HandlerInfo { target: h.target.to_string(), event: h.event }).collect()).unwrap_or_default();
    CheckOutput { diagnostics, metadata, handlers, program }
}

pub fn wire_diagnostics(diags: &[Diagnostic]) -> Vec<WireDiagnostic> {
    diags.iter().map(WireDiagnostic::from).collect()
}

fn exec_error(e: &RtError) -> ExecError {
    ExecError { code: e.code.to_string(), kind: e.kind_name().to_string(), message: e.message.clone(), line: e.span.line, col: e.span.col }
}

/// Run an entry point of a checked program. Rejections, limit breaches and runtime errors are
/// reported in the result; intents are returned only when the run succeeded.
pub fn execute(program: &Program, ctx: &ExecContext, entry: &Entry, host: &mut dyn Host) -> ExecuteResult {
    let mut it = Interp::new(program, ctx, host);
    let mut object_out = None;
    let outcome = run_entry(&mut it, program, ctx, entry, &mut object_out);
    let stats = Stats { steps: it.steps, host_calls: it.host_calls, queries: it.queries, micros: it.elapsed_micros() };
    let logs = std::mem::take(&mut it.logs);
    match outcome {
        Ok(value) => {
            let object = object_out.as_ref().map(|o: &std::rc::Rc<std::cell::RefCell<value::Obj>>| obj_to_wire(&o.borrow(), &program.metadata));
            match value.map(|v| value_to_wire(&v, &program.metadata)).transpose() {
                Ok(value) => ExecuteResult { ok: true, value, object, intents: std::mem::take(&mut it.intents), logs, error: None, stats },
                Err(m) => {
                    let e = RtError::new(codes::TYPE, Kind::Type, format!("The result cannot be returned to the platform: {m}."), Span::default());
                    ExecuteResult { ok: false, value: None, object: None, intents: Vec::new(), logs, error: Some(exec_error(&e)), stats }
                }
            }
        }
        Err(e) => ExecuteResult { ok: false, value: None, object: None, intents: Vec::new(), logs, error: Some(exec_error(&e)), stats },
    }
}

fn run_entry(it: &mut Interp, program: &Program, ctx: &ExecContext, entry: &Entry, object_out: &mut Option<std::rc::Rc<std::cell::RefCell<value::Obj>>>) -> Result<Option<Value>, RtError> {
    let at = Span::default();
    if ctx.event_depth > ctx.limits.max_event_depth {
        return Err(RtError::new(
            codes::EVENT_DEPTH,
            Kind::Limit,
            format!("Event handlers nested more than {} levels (an object saved from a handler whose handler saves another…).", ctx.limits.max_event_depth),
            at,
        ));
    }
    match entry {
        Entry::Script => {
            let body = program.script.as_ref().ok_or_else(|| RtError::new(codes::NO_ENTRY, Kind::Runtime, "The program has no top-level statements to run.", at))?;
            Ok(Some(it.run_body(body, Vec::new())?))
        }
        Entry::Function { name, args } => {
            let index = program.function(name).ok_or_else(|| RtError::new(codes::NO_ENTRY, Kind::Runtime, format!("The program has no function \"{name}\"."), at))?;
            let f = &program.functions[index as usize];
            if args.len() != f.params.len() {
                return Err(RtError::new(codes::ARGS, Kind::Type, format!("{name} takes {} argument(s); {} given.", f.params.len(), args.len()), at));
            }
            let values =
                args.iter().map(|a| wire_to_value(a, &program.metadata)).collect::<Result<Vec<_>, _>>().map_err(|m| RtError::new(codes::HOST, Kind::Host, format!("Invalid argument: {m}."), at))?;
            let args: Vec<Arg> = values.into_iter().map(|value| Arg { name: None, value }).collect();
            Ok(Some(it.call_entry_function(index, args)?))
        }
        Entry::Handler { target, event, object } => {
            if object.type_name != *target {
                return Err(RtError::new(codes::HOST, Kind::Host, format!("The handler for {target} was given a {}.", object.type_name), at));
            }
            let obj = obj_from_wire(object, &program.metadata).map_err(|m| RtError::new(codes::HOST, Kind::Host, format!("Invalid object: {m}."), at))?;
            *object_out = Some(obj.clone());
            let Some(handler) = program.handler(target, *event) else {
                return Ok(None);
            };
            let writable = matches!(event, Event::BeforeCreate | Event::BeforeSave);
            obj.borrow_mut().lock = Some(Lock { writable, reason: LockReason::Handler(*event) });
            it.posting = *event == Event::Post;
            let r = it.run_body(&handler.body, vec![Value::Object(obj.clone())]);
            it.posting = false;
            obj.borrow_mut().lock = None;
            r.map(|_| None)
        }
    }
}

impl Interp<'_> {
    fn call_entry_function(&mut self, index: u32, args: Vec<Arg>) -> Result<Value, RtError> {
        let prog = self.prog;
        let f = &prog.functions[index as usize];
        self.run_body(&f.body, args.into_iter().map(|a| a.value).collect())
    }
}
