//! `vks worker`: the isolated execution process. It reads `vks/1` envelopes, one JSON object
//! per line, from stdin and writes responses to stdout. Diagnostics for operators go to stderr.
//!
//! While a script runs, every platform operation becomes a `hostCall` request on stdout; the
//! worker then reads stdin until the matching `hostResult` arrives. The platform may send a
//! nested `execute` first (to run an event handler of an object the script is saving); the
//! worker runs it re-entrantly and answers it before continuing to wait.

use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::rc::Rc;
use vks_protocol::{Envelope, ExecContext, HostCall, HostError, Message, Program as WireProgram, WireValue, PROTOCOL};
use vks_runtime::{check, execute, wire_diagnostics, Host, Options, Program};

/// Largest accepted request line. Sources and objects are far smaller; this bounds memory if
/// the platform misbehaves.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
/// Compiled programs kept per worker (by the platform's cache key).
const MAX_CACHED_PROGRAMS: usize = 64;

pub struct Worker<R: BufRead, W: Write> {
    input: R,
    output: W,
    cache: HashMap<String, Rc<Program>>,
    next_id: u64,
}

// Short-lived: one value per line read, so the size difference does not matter.
#[allow(clippy::large_enum_variant)]
enum Incoming {
    Message(u64, Message),
    Eof,
}

impl<R: BufRead, W: Write> Worker<R, W> {
    pub fn new(input: R, output: W) -> Self {
        // Worker-originated ids start high so they never look like the platform's.
        Worker { input, output, cache: HashMap::new(), next_id: 1 << 48 }
    }

    fn send(&mut self, id: u64, message: Message) -> io::Result<()> {
        let line = serde_json::to_string(&Envelope::new(id, message)).map_err(io::Error::other)?;
        self.output.write_all(line.as_bytes())?;
        self.output.write_all(b"\n")?;
        self.output.flush()
    }

    fn read(&mut self) -> io::Result<Incoming> {
        loop {
            let mut line = String::new();
            let n = Read::take(&mut self.input, MAX_LINE_BYTES as u64 + 1).read_line(&mut line)?;
            if n == 0 {
                return Ok(Incoming::Eof);
            }
            if line.len() > MAX_LINE_BYTES {
                self.send(0, Message::ProtocolError { message: format!("Request larger than {MAX_LINE_BYTES} bytes.") })?;
                return Ok(Incoming::Eof);
            }
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Envelope>(&line) {
                Ok(env) if env.protocol == PROTOCOL => return Ok(Incoming::Message(env.id, env.message)),
                Ok(env) => self.send(env.id, Message::ProtocolError { message: format!("Unsupported protocol \"{}\"; this worker speaks {PROTOCOL}.", env.protocol) })?,
                Err(e) => self.send(0, Message::ProtocolError { message: format!("Invalid request: {e}") })?,
            }
        }
    }

    fn program(&mut self, p: &WireProgram) -> Result<Rc<Program>, String> {
        if let Some(prog) = self.cache.get(&p.key) {
            return Ok(prog.clone());
        }
        let out = check(&p.source, Options { allow_script: true });
        let Some(prog) = out.program else {
            let first = out.diagnostics.iter().find(|d| d.severity == vks_syntax::Severity::Error).map(|d| d.to_string()).unwrap_or_default();
            return Err(format!("The program does not compile: {first}"));
        };
        if self.cache.len() >= MAX_CACHED_PROGRAMS {
            self.cache.clear();
        }
        let prog = Rc::new(prog);
        self.cache.insert(p.key.clone(), prog.clone());
        Ok(prog)
    }

    /// Handle one request. Returns false when the worker should stop.
    fn handle(&mut self, id: u64, message: Message) -> io::Result<bool> {
        match message {
            Message::Check { source, script } => {
                let out = check(&source, Options { allow_script: script });
                self.send(id, Message::CheckResult { diagnostics: wire_diagnostics(&out.diagnostics), metadata: out.metadata, handlers: out.handlers })?;
            }
            Message::Plan { source, previous } => {
                let out = check(&source, Options::default());
                let plan = match (&out.metadata, vks_syntax::has_errors(&out.diagnostics)) {
                    (Some(m), false) => Some(vks_metadata::plan_migration(previous.as_ref(), m)),
                    _ => None,
                };
                self.send(id, Message::PlanResult { diagnostics: wire_diagnostics(&out.diagnostics), metadata: out.metadata, plan })?;
            }
            Message::Execute { program, context, entry } => {
                let result = match self.program(&program) {
                    Ok(prog) => execute(&prog, &context, &entry, self),
                    Err(m) => vks_protocol::ExecuteResult {
                        ok: false,
                        value: None,
                        object: None,
                        intents: Vec::new(),
                        logs: Vec::new(),
                        error: Some(vks_protocol::ExecError { code: "VKS1000".into(), kind: "syntax".into(), message: m, line: 0, col: 0 }),
                        stats: Default::default(),
                    },
                };
                self.send(id, Message::ExecuteResult(result))?;
            }
            Message::Shutdown => return Ok(false),
            other => {
                let name = serde_json::to_value(&other).ok().and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string)).unwrap_or_default();
                self.send(id, Message::ProtocolError { message: format!("The worker does not accept \"{name}\" here.") })?;
            }
        }
        Ok(true)
    }

    pub fn run(&mut self) -> io::Result<()> {
        loop {
            match self.read()? {
                Incoming::Eof => return Ok(()),
                Incoming::Message(id, message) => {
                    if !self.handle(id, message)? {
                        return Ok(());
                    }
                }
            }
        }
    }
}

impl<R: BufRead, W: Write> Host for Worker<R, W> {
    fn call(&mut self, call: HostCall, _ctx: &ExecContext) -> Result<WireValue, HostError> {
        let io_err = |e: io::Error| HostError { code: "internal".into(), message: format!("Lost the connection to the platform: {e}") };
        let id = self.next_id;
        self.next_id += 1;
        self.send(id, Message::HostCall(call)).map_err(io_err)?;
        loop {
            match self.read().map_err(io_err)? {
                Incoming::Eof => return Err(HostError { code: "internal".into(), message: "The platform closed the connection during a call.".into() }),
                Incoming::Message(rid, Message::HostResult { ok, error }) if rid == id => {
                    return match (ok, error) {
                        (_, Some(e)) => Err(e),
                        (Some(v), None) => Ok(v),
                        (None, None) => Ok(WireValue::Null),
                    };
                }
                // A nested execution (an event handler) requested by the platform mid-call.
                Incoming::Message(rid, m @ Message::Execute { .. }) => {
                    self.handle(rid, m).map_err(io_err)?;
                }
                Incoming::Message(rid, Message::Shutdown) => {
                    let _ = rid;
                    std::process::exit(0);
                }
                Incoming::Message(rid, _) => {
                    self.send(rid, Message::ProtocolError { message: format!("Expected the result of host call {id}.") }).map_err(io_err)?;
                }
            }
        }
    }
}
