//! The interpreter. It runs a checked [`Program`] under the limits of its [`ExecContext`],
//! asks the [`Host`] for every platform operation and collects posting intents.

use crate::compile::{Body, Ex, Program, St, A, E, S};
use crate::convert::{self, coerce_field, obj_from_wire, obj_to_wire, value_to_wire, wire_to_value};
use crate::error::{codes, RtError, RtResult};
use crate::ops;
use crate::value::{FuncVal, Lock, LockReason, Obj, OrderedMap, RefVal, Root, RowData, Service, Status, Value};
use chrono::NaiveDateTime;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;
use vks_metadata::{MetadataModel, ObjectKind};
use vks_protocol::{ExecContext, HostCall, HostError, Intent, Limits, LogEntry, WireValue};
use vks_syntax::ast::{AssignOp, BinaryOp};
use vks_syntax::{Kind, Span};

/// The platform side of script execution. The runtime checks capabilities and limits before
/// every call; the platform must check again, because it is the authority.
pub trait Host {
    fn call(&mut self, call: HostCall, ctx: &ExecContext) -> Result<WireValue, HostError>;
}

/// A host for code that must not touch business data (pure functions, tests).
pub struct NoHost;

impl Host for NoHost {
    fn call(&mut self, _call: HostCall, _ctx: &ExecContext) -> Result<WireValue, HostError> {
        Err(HostError { code: "unsupported".into(), message: "No platform is attached to this execution.".into() })
    }
}

/// Stack size the engine expects its thread to have. [`with_engine_stack`] provides it.
pub const ENGINE_STACK_SIZE: usize = 64 * 1024 * 1024;
/// Stack the interpreter allows itself before failing with a limit error (below the thread size
/// so the error is reported instead of the process crashing).
pub const STACK_BUDGET: usize = 48 * 1024 * 1024;

thread_local! {
    static STACK_BASE: Cell<usize> = const { Cell::new(0) };
}

/// Run `f` on a thread with [`ENGINE_STACK_SIZE`] of stack. Hosts call the engine through this.
pub fn with_engine_stack<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    std::thread::scope(|s| {
        std::thread::Builder::new().name("vks-engine".into()).stack_size(ENGINE_STACK_SIZE).spawn_scoped(s, f).expect("engine thread starts").join().expect("engine thread does not panic")
    })
}

#[inline(never)]
fn stack_address() -> usize {
    let marker = 0u8;
    std::hint::black_box(&marker) as *const u8 as usize
}

/// Objects read through references during one execution, by (type, id).
type RefCache = HashMap<(Rc<str>, Rc<str>), Rc<RefCell<Obj>>>;

pub(crate) enum Flow {
    Next,
    Break,
    Continue,
    Return(Value),
}

/// An evaluated call argument.
pub(crate) struct Arg {
    pub name: Option<Rc<str>>,
    pub value: Value,
}

pub struct Interp<'a> {
    pub(crate) prog: &'a Program,
    pub(crate) meta: &'a MetadataModel,
    pub(crate) ctx: &'a ExecContext,
    host: &'a mut dyn Host,
    pub(crate) limits: Limits,
    started: Instant,
    pub(crate) steps: u64,
    pub(crate) host_calls: u32,
    pub(crate) queries: u32,
    mem: usize,
    depth: u32,
    pub(crate) intents: Vec<Intent>,
    pub(crate) logs: Vec<LogEntry>,
    /// True while a Post handler runs: register movements are allowed.
    pub(crate) posting: bool,
    pub(crate) now: NaiveDateTime,
    stack_base: usize,
    owns_stack_base: bool,
    ref_cache: RefCache,
}

impl Drop for Interp<'_> {
    fn drop(&mut self) {
        if self.owns_stack_base {
            STACK_BASE.with(|b| b.set(0));
        }
    }
}

impl<'a> Interp<'a> {
    pub fn new(prog: &'a Program, ctx: &'a ExecContext, host: &'a mut dyn Host) -> Self {
        let here = stack_address();
        let (stack_base, owns_stack_base) = STACK_BASE.with(|b| {
            if b.get() == 0 {
                b.set(here);
                (here, true)
            } else {
                (b.get(), false)
            }
        });
        let now = convert::parse_datetime(&ctx.now).unwrap_or_else(|| {
            use chrono::Timelike;
            chrono::Utc::now().naive_utc().with_nanosecond(0).expect("valid time")
        });
        Interp {
            prog,
            meta: &prog.metadata,
            ctx,
            host,
            limits: ctx.limits.clone(),
            started: Instant::now(),
            steps: 0,
            host_calls: 0,
            queries: 0,
            mem: 0,
            depth: 0,
            intents: Vec::new(),
            logs: Vec::new(),
            posting: false,
            now,
            stack_base,
            owns_stack_base,
            ref_cache: HashMap::new(),
        }
    }

    pub fn elapsed_micros(&self) -> u64 {
        self.started.elapsed().as_micros() as u64
    }

    // ----- limits -------------------------------------------------------------------------

    fn limit(code: &'static str, message: String, span: Span) -> RtError {
        RtError::new(code, Kind::Limit, message, span)
    }

    #[inline]
    fn tick(&mut self, span: Span) -> RtResult<()> {
        self.steps += 1;
        if self.steps > self.limits.max_steps {
            return Err(Self::limit(codes::STEPS, format!("The script ran more than {} steps.", self.limits.max_steps), span));
        }
        if self.steps & 1023 == 0 {
            self.check_time(span)?;
        }
        Ok(())
    }

    fn check_time(&self, span: Span) -> RtResult<()> {
        if self.started.elapsed().as_millis() as u64 > self.limits.max_millis {
            return Err(Self::limit(codes::TIME, format!("The script ran longer than {} ms.", self.limits.max_millis), span));
        }
        Ok(())
    }

    pub(crate) fn charge(&mut self, bytes: usize, span: Span) -> RtResult<()> {
        self.mem = self.mem.saturating_add(bytes);
        if self.mem > self.limits.max_memory_bytes {
            return Err(Self::limit(codes::MEMORY, format!("The script allocated more than {} bytes.", self.limits.max_memory_bytes), span));
        }
        Ok(())
    }

    pub(crate) fn check_len(&self, len: usize, span: Span) -> RtResult<()> {
        if len > self.limits.max_collection_len {
            return Err(Self::limit(codes::COLLECTION, format!("A collection would exceed {} elements.", self.limits.max_collection_len), span));
        }
        Ok(())
    }

    /// Account for a new string and check its size.
    pub(crate) fn new_str(&mut self, s: String, span: Span) -> RtResult<Value> {
        if s.len() > self.limits.max_string_bytes {
            return Err(Self::limit(codes::STRING, format!("A string would exceed {} bytes.", self.limits.max_string_bytes), span));
        }
        self.charge(s.len() + 16, span)?;
        Ok(Value::Str(Rc::from(s)))
    }

    pub(crate) fn new_array(&mut self, items: Vec<Value>, span: Span) -> RtResult<Value> {
        self.check_len(items.len(), span)?;
        self.charge(items.len() * 32 + 32, span)?;
        Ok(Value::array(items))
    }

    fn check_stack(&self, span: Span) -> RtResult<()> {
        let used = self.stack_base.saturating_sub(stack_address());
        if used > STACK_BUDGET {
            return Err(Self::limit(codes::STACK, "The script nested too deeply.".into(), span));
        }
        Ok(())
    }

    // ----- host --------------------------------------------------------------------------

    pub(crate) fn host_call(&mut self, call: HostCall, span: Span) -> RtResult<WireValue> {
        let cap = call.capability();
        if !self.ctx.can(cap) {
            return Err(RtError::new(codes::PERMISSION, Kind::Permission, format!("This operation needs the \"{cap}\" permission, which {} does not have.", self.ctx.user), span));
        }
        self.host_calls += 1;
        if self.host_calls > self.limits.max_host_calls {
            return Err(Self::limit(codes::HOST_CALLS, format!("The script made more than {} platform calls.", self.limits.max_host_calls), span));
        }
        if call.is_query() {
            self.queries += 1;
            if self.queries > self.limits.max_queries {
                return Err(Self::limit(codes::QUERIES, format!("The script ran more than {} queries.", self.limits.max_queries), span));
            }
        }
        self.check_time(span)?;
        let result = self.host.call(call, self.ctx).map_err(|e| host_error(e, span));
        self.check_time(span)?;
        result
    }

    pub(crate) fn decode_wire(&self, w: &WireValue, span: Span) -> RtResult<Value> {
        wire_to_value(w, self.meta).map_err(|m| RtError::new(codes::HOST, Kind::Host, format!("The platform returned invalid data: {m}."), span))
    }

    pub(crate) fn to_wire(&self, v: &Value, span: Span) -> RtResult<WireValue> {
        value_to_wire(v, self.meta).map_err(|m| RtError::new(codes::TYPE, Kind::Type, format!("Cannot pass this value to the platform: {m}."), span))
    }

    /// Read access to a referenced object, loaded once per execution.
    fn deref(&mut self, r: &RefVal, span: Span) -> RtResult<Rc<RefCell<Obj>>> {
        let key = (r.type_name.clone(), r.id.clone());
        if let Some(o) = self.ref_cache.get(&key) {
            return Ok(o.clone());
        }
        let o = self.load(r, span)?;
        o.borrow_mut().lock = Some(Lock { writable: false, reason: LockReason::Reference });
        self.ref_cache.insert(key, o.clone());
        Ok(o)
    }

    pub(crate) fn load(&mut self, r: &RefVal, span: Span) -> RtResult<Rc<RefCell<Obj>>> {
        let w = self.host_call(HostCall::FindById { kind: r.kind, type_name: r.type_name.to_string(), id: r.id.to_string() }, span)?;
        match self.decode_wire(&w, span)? {
            Value::Object(o) => Ok(o),
            _ => Err(RtError::new(codes::HOST_NOT_FOUND, Kind::Host, format!("{}({}) does not exist.", r.type_name, r.id), span)),
        }
    }

    pub(crate) fn forget(&mut self, type_name: &Rc<str>, id: &Rc<str>) {
        self.ref_cache.remove(&(type_name.clone(), id.clone()));
    }

    // ----- statements --------------------------------------------------------------------

    pub(crate) fn run_body(&mut self, body: &Body, mut args: Vec<Value>) -> RtResult<Value> {
        args.resize(body.slots.max(args.len()), Value::Null);
        match self.block(&mut args, &body.stmts)? {
            Flow::Return(v) => Ok(v),
            _ => Ok(Value::Null),
        }
    }

    fn block(&mut self, frame: &mut [Value], stmts: &[S]) -> RtResult<Flow> {
        for s in stmts {
            self.tick(s.span)?;
            match self.stmt(frame, s)? {
                Flow::Next => {}
                other => return Ok(other),
            }
        }
        Ok(Flow::Next)
    }

    fn cond(&mut self, frame: &mut [Value], e: &E) -> RtResult<bool> {
        match self.eval(frame, e)? {
            Value::Bool(b) => Ok(b),
            v => Err(RtError::new(codes::CONDITION, Kind::Type, format!("A condition must be Boolean, not {}. Compare explicitly, e.g. x > 0 or x != null.", v.kind_name()), e.span)),
        }
    }

    fn compound(&mut self, op: AssignOp, current: Value, v: Value, span: Span) -> RtResult<Value> {
        let bop = match op {
            AssignOp::Set => return Ok(v),
            AssignOp::Add => BinaryOp::Add,
            AssignOp::Sub => BinaryOp::Sub,
        };
        let r = ops::arith(bop, &current, &v, span)?;
        if let Value::Str(s) = &r {
            if s.len() > self.limits.max_string_bytes {
                return Err(Self::limit(codes::STRING, format!("A string would exceed {} bytes.", self.limits.max_string_bytes), span));
            }
            self.charge(s.len() + 16, span)?;
        }
        Ok(r)
    }

    fn loop_body(&mut self, frame: &mut [Value], body: &[S]) -> RtResult<Option<Flow>> {
        match self.block(frame, body)? {
            Flow::Break => Ok(Some(Flow::Next)),
            Flow::Return(v) => Ok(Some(Flow::Return(v))),
            Flow::Next | Flow::Continue => Ok(None),
        }
    }

    fn stmt(&mut self, frame: &mut [Value], s: &S) -> RtResult<Flow> {
        match &s.kind {
            St::Let(slot, e) => {
                frame[*slot as usize] = self.eval(frame, e)?;
            }
            St::SetLocal(slot, op, e) => {
                let v = self.eval(frame, e)?;
                let cur = std::mem::replace(&mut frame[*slot as usize], Value::Null);
                frame[*slot as usize] = match self.compound(*op, cur.clone(), v, s.span) {
                    Ok(v) => v,
                    Err(e) => {
                        frame[*slot as usize] = cur;
                        return Err(e);
                    }
                };
            }
            St::SetMember(o, name, op, e) => {
                let target = self.eval(frame, o)?;
                let v = self.eval(frame, e)?;
                let v = if *op == AssignOp::Set {
                    v
                } else {
                    let current = self.get_member(&target, name, o.span)?;
                    self.compound(*op, current, v, s.span)?
                };
                self.set_member(&target, name, v, s.span)?;
            }
            St::SetIndex(o, i, op, e) => {
                let target = self.eval(frame, o)?;
                let index = self.eval(frame, i)?;
                let v = self.eval(frame, e)?;
                let v = if *op == AssignOp::Set {
                    v
                } else {
                    let current = self.get_index(&target, &index, i.span)?;
                    self.compound(*op, current, v, s.span)?
                };
                self.set_index(&target, &index, v, s.span)?;
            }
            St::If(c, then, otherwise) => {
                let branch = if self.cond(frame, c)? { then } else { otherwise };
                return self.block(frame, branch);
            }
            St::While(c, body) => loop {
                self.tick(s.span)?;
                if !self.cond(frame, c)? {
                    break;
                }
                if let Some(flow) = self.loop_body(frame, body)? {
                    return Ok(flow);
                }
            },
            St::For(slot, e, body) => {
                let iterable = self.eval(frame, e)?;
                let items = self.iterate(iterable, e.span)?;
                for v in items {
                    self.tick(s.span)?;
                    frame[*slot as usize] = v;
                    if let Some(flow) = self.loop_body(frame, body)? {
                        return Ok(flow);
                    }
                }
            }
            St::ForRange(slot, a, b, body) => {
                let first = self.int_arg(frame, a)?;
                let (start, end) = match b {
                    Some(b) => (first, self.int_arg(frame, b)?),
                    None => (0, first),
                };
                let mut i = start;
                while i < end {
                    self.tick(s.span)?;
                    frame[*slot as usize] = Value::Int(i);
                    if let Some(flow) = self.loop_body(frame, body)? {
                        return Ok(flow);
                    }
                    i += 1;
                }
            }
            St::Return(e) => {
                let v = match e {
                    Some(e) => self.eval(frame, e)?,
                    None => Value::Null,
                };
                return Ok(Flow::Return(v));
            }
            St::Break => return Ok(Flow::Break),
            St::Continue => return Ok(Flow::Continue),
            St::Expr(e) => {
                self.eval(frame, e)?;
            }
        }
        Ok(Flow::Next)
    }

    fn int_arg(&mut self, frame: &mut [Value], e: &E) -> RtResult<i64> {
        match self.eval(frame, e)? {
            Value::Int(i) => Ok(i),
            v => Err(RtError::new(codes::TYPE, Kind::Type, format!("range() takes Integer bounds, not {}.", v.kind_name()), e.span)),
        }
    }

    fn iterate(&mut self, v: Value, span: Span) -> RtResult<Vec<Value>> {
        Ok(match v {
            Value::Array(a) => a.borrow().clone(),
            Value::Map(m) => m.borrow().iter().map(|(k, _)| Value::Str(k.clone())).collect(),
            Value::Rows(o, i) => o.borrow().rows[i].iter().map(|r| Value::Row(r.clone())).collect(),
            Value::Null => return Err(RtError::new(codes::NULL_ACCESS, Kind::Runtime, "Cannot loop over null.", span)),
            v => return Err(RtError::new(codes::NOT_ITERABLE, Kind::Type, format!("Cannot loop over {}; loop over an Array, Map, rows or range(n).", v.kind_name()), span)),
        })
    }

    // ----- expressions -------------------------------------------------------------------

    pub(crate) fn eval(&mut self, frame: &mut [Value], e: &E) -> RtResult<Value> {
        Ok(match &e.kind {
            Ex::Const(v) => v.clone(),
            Ex::Local(slot) => frame[*slot as usize].clone(),
            Ex::Func(i) => Value::Func(FuncVal::User(*i)),
            Ex::Builtin(b) => Value::Func(FuncVal::Builtin(*b)),
            Ex::Root(r) => Value::Service(Service::Root(*r)),
            Ex::Manager(r, n) => Value::Service(Service::Manager(*r, n.clone())),
            Ex::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for i in items {
                    out.push(self.eval(frame, i)?);
                }
                self.new_array(out, e.span)?
            }
            Ex::Map(entries) => {
                let mut m = OrderedMap::new();
                for (k, v) in entries {
                    let v = self.eval(frame, v)?;
                    m.insert(k.clone(), v);
                }
                self.check_len(m.len(), e.span)?;
                self.charge(m.len() * 48 + 32, e.span)?;
                Value::map(m)
            }
            Ex::Member(o, name) => {
                let v = self.eval(frame, o)?;
                self.get_member(&v, name, e.span)?
            }
            Ex::Index(o, i) => {
                let v = self.eval(frame, o)?;
                let i = self.eval(frame, i)?;
                self.get_index(&v, &i, e.span)?
            }
            Ex::CallFunc(i, args) => {
                let args = self.eval_args(frame, args)?;
                self.call_user(*i, args, e.span)?
            }
            Ex::CallBuiltin(b, args) => {
                let args = self.eval_args(frame, args)?;
                self.call_builtin(*b, args, e.span)?
            }
            Ex::CallValue(c, args) => {
                let callee = self.eval(frame, c)?;
                let args = self.eval_args(frame, args)?;
                match callee {
                    Value::Func(FuncVal::User(i)) => self.call_user(i, args, e.span)?,
                    Value::Func(FuncVal::Builtin(b)) => self.call_builtin(b, args, e.span)?,
                    v => return Err(RtError::new(codes::NOT_CALLABLE, Kind::Type, format!("{} is not a function.", v.kind_name()), c.span)),
                }
            }
            Ex::CallMethod(o, name, args) => {
                let recv = self.eval(frame, o)?;
                let args = self.eval_args(frame, args)?;
                self.call_method(recv, name, args, e.span)?
            }
            Ex::Neg(x) => {
                let v = self.eval(frame, x)?;
                ops::negate(&v, e.span)?
            }
            Ex::Not(x) => match self.eval(frame, x)? {
                Value::Bool(b) => Value::Bool(!b),
                v => return Err(RtError::new(codes::CONDITION, Kind::Type, format!("! needs a Boolean, not {}.", v.kind_name()), x.span)),
            },
            Ex::Bin(op, l, r) => {
                let a = self.eval(frame, l)?;
                let b = self.eval(frame, r)?;
                let v = ops::binary(*op, &a, &b, e.span)?;
                if let Value::Str(s) = &v {
                    if s.len() > self.limits.max_string_bytes {
                        return Err(Self::limit(codes::STRING, format!("A string would exceed {} bytes.", self.limits.max_string_bytes), e.span));
                    }
                    self.charge(s.len() + 16, e.span)?;
                }
                v
            }
            Ex::And(l, r) => Value::Bool(self.cond(frame, l)? && self.cond(frame, r)?),
            Ex::Or(l, r) => Value::Bool(self.cond(frame, l)? || self.cond(frame, r)?),
        })
    }

    fn eval_args(&mut self, frame: &mut [Value], args: &[A]) -> RtResult<Vec<Arg>> {
        let mut out = Vec::with_capacity(args.len());
        for a in args {
            out.push(Arg { name: a.name.clone(), value: self.eval(frame, &a.value)? });
        }
        Ok(out)
    }

    /// Match arguments to parameters: positional first, then named; every parameter once.
    /// Returns one slot per parameter (None when not given) plus extra positional values.
    pub(crate) fn bind(&self, what: &str, params: &[&str], required: usize, variadic: bool, args: Vec<Arg>, span: Span) -> RtResult<(Vec<Option<Value>>, Vec<Value>)> {
        let err = |m: String| RtError::new(codes::ARGS, Kind::Type, m, span);
        let mut slots: Vec<Option<Value>> = vec![None; params.len()];
        let mut extra = Vec::new();
        let mut pos = 0;
        for a in args {
            match a.name {
                None => {
                    if pos < params.len() {
                        slots[pos] = Some(a.value);
                    } else if variadic {
                        extra.push(a.value);
                    } else {
                        return Err(err(format!("{what} takes {} argument(s).", params.len())));
                    }
                    pos += 1;
                }
                Some(n) => {
                    let Some(i) = params.iter().position(|p| **p == *n) else {
                        return Err(err(format!("{what} has no parameter named \"{n}\".")));
                    };
                    if slots[i].is_some() {
                        return Err(err(format!("Argument \"{n}\" of {what} is given twice.")));
                    }
                    slots[i] = Some(a.value);
                }
            }
        }
        if let Some(i) = (0..required).find(|i| slots[*i].is_none()) {
            return Err(err(format!("{what} needs the argument \"{}\".", params[i])));
        }
        Ok((slots, extra))
    }

    fn call_user(&mut self, index: u32, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let prog = self.prog;
        let f = &prog.functions[index as usize];
        let params: Vec<&str> = f.params.iter().map(|p| &**p).collect();
        let (slots, _) = self.bind(&f.name, &params, params.len(), false, args, span)?;
        if self.depth >= self.limits.max_call_depth {
            return Err(Self::limit(codes::CALL_DEPTH, format!("More than {} nested function calls.", self.limits.max_call_depth), span));
        }
        self.check_stack(span)?;
        self.depth += 1;
        let r = self.run_body(&f.body, slots.into_iter().map(|v| v.unwrap_or(Value::Null)).collect());
        self.depth -= 1;
        r
    }

    // ----- members and indexes -----------------------------------------------------------

    fn no_member(v: &Value, name: &str, span: Span) -> RtError {
        if matches!(v, Value::Null) {
            return RtError::new(codes::NULL_ACCESS, Kind::Runtime, format!("Cannot read \"{name}\" of null."), span);
        }
        RtError::new(codes::NO_MEMBER, Kind::Type, format!("{} has no member \"{name}\".", v.type_name()), span)
    }

    pub(crate) fn get_member(&mut self, v: &Value, name: &str, span: Span) -> RtResult<Value> {
        match v {
            Value::Map(m) => Ok(m.borrow().get(name).cloned().unwrap_or(Value::Null)),
            Value::Object(o) => self.obj_member(o, name, span),
            Value::Ref(r) => {
                if name == "id" {
                    return Ok(Value::Str(r.id.clone()));
                }
                let o = self.deref(r, span)?;
                self.obj_member(&o, name, span)
            }
            Value::Row(r) => {
                let row = r.borrow();
                if name == "lineNo" {
                    return Ok(Value::Int(row.line_no as i64));
                }
                let fields = &self.meta.document(&row.doc_type).expect("row of known document").rows[row.rows_index].fields;
                match fields.iter().position(|f| f.name == name) {
                    Some(i) => Ok(row.fields[i].clone()),
                    None => Err(Self::no_member(v, name, span)),
                }
            }
            Value::Money(a, c) => match name {
                "amount" => Ok(Value::Dec(*a)),
                "currency" => Ok(Value::Str(c.clone())),
                _ => Err(Self::no_member(v, name, span)),
            },
            Value::Service(Service::Root(Root::Context)) => Ok(match name {
                "user" => Value::str(&self.ctx.user),
                "organization" => Value::str(&self.ctx.organization),
                "application" => Value::str(&self.ctx.application),
                "operation" => Value::str(&self.ctx.operation),
                "correlationId" => Value::str(&self.ctx.correlation_id),
                _ => return Err(Self::no_member(v, name, span)),
            }),
            _ => Err(Self::no_member(v, name, span)),
        }
    }

    fn obj_member(&mut self, o: &Rc<RefCell<Obj>>, name: &str, span: Span) -> RtResult<Value> {
        let obj = o.borrow();
        if let Some(i) = self.meta.object_fields(&obj.type_name).and_then(|fs| fs.iter().position(|f| f.name == name)) {
            return Ok(obj.fields[i].clone());
        }
        let is_doc = obj.kind == ObjectKind::Document;
        if is_doc {
            if let Some(i) = self.meta.document(&obj.type_name).and_then(|d| d.rows.iter().position(|r| r.name == name)) {
                return Ok(Value::Rows(o.clone(), i));
            }
        }
        Ok(match name {
            "id" => obj.id.clone().map(Value::Str).unwrap_or(Value::Null),
            "version" => obj.version.map(Value::Int).unwrap_or(Value::Null),
            "deleted" => Value::Bool(obj.deleted),
            "number" if is_doc => obj.number.clone().map(Value::Str).unwrap_or(Value::Null),
            "date" if is_doc => obj.date.map(Value::Date).unwrap_or(Value::Null),
            "status" if is_doc => Value::str(obj.status.unwrap_or(Status::Draft).name()),
            _ => {
                drop(obj);
                return Err(Self::no_member(&Value::Object(o.clone()), name, span));
            }
        })
    }

    pub(crate) fn check_writable(&self, lock: Option<Lock>, type_name: &str, span: Span) -> RtResult<()> {
        match lock {
            Some(Lock { writable: false, reason: LockReason::Handler(ev) }) => {
                Err(RtError::new(codes::READ_ONLY, Kind::Runtime, format!("{type_name} cannot be changed in its {} handler; set fields in BeforeSave.", ev.name()), span))
            }
            Some(Lock { writable: false, reason: LockReason::Reference }) => {
                Err(RtError::new(codes::READ_ONLY, Kind::Runtime, format!("Data read through a reference to {type_name} is read-only; call load() to change it."), span))
            }
            _ => Ok(()),
        }
    }

    pub(crate) fn set_member(&mut self, target: &Value, name: &str, v: Value, span: Span) -> RtResult<()> {
        match target {
            Value::Map(m) => {
                let mut m = m.borrow_mut();
                if m.insert(Rc::from(name), v) {
                    self.check_len(m.len(), span)?;
                    self.charge(48 + name.len(), span)?;
                }
                Ok(())
            }
            Value::Object(o) => self.set_field(o, name, v, span),
            Value::Row(r) => {
                let (doc_type, rows_index, parent) = {
                    let row = r.borrow();
                    (row.doc_type.clone(), row.rows_index, row.parent.upgrade())
                };
                if let Some(p) = parent {
                    self.check_writable(p.borrow().lock, &doc_type, span)?;
                }
                if name == "lineNo" {
                    return Err(RtError::new(codes::READ_ONLY, Kind::Runtime, "\"lineNo\" is managed by the platform.", span));
                }
                let fields = &self.meta.document(&doc_type).expect("known document").rows[rows_index].fields;
                let Some(i) = fields.iter().position(|f| f.name == name) else {
                    return Err(Self::no_member(target, name, span));
                };
                let v = coerce_field(&fields[i], v).map_err(|(c, m)| RtError::new(c, Kind::Type, m, span))?;
                r.borrow_mut().fields[i] = v;
                Ok(())
            }
            Value::Ref(r) => Err(RtError::new(codes::READ_ONLY, Kind::Runtime, format!("A reference to {} is read-only; call load() to change it.", r.type_name), span)),
            Value::Null => Err(RtError::new(codes::NULL_ACCESS, Kind::Runtime, format!("Cannot set \"{name}\" of null."), span)),
            _ => Err(Self::no_member(target, name, span)),
        }
    }

    pub(crate) fn set_field(&mut self, o: &Rc<RefCell<Obj>>, name: &str, v: Value, span: Span) -> RtResult<()> {
        let (type_name, kind, lock) = {
            let obj = o.borrow();
            (obj.type_name.clone(), obj.kind, obj.lock)
        };
        self.check_writable(lock, &type_name, span)?;
        if let Some((i, f)) = self.meta.object_fields(&type_name).and_then(|fs| fs.iter().enumerate().find(|(_, f)| f.name == name)) {
            let v = coerce_field(f, v).map_err(|(c, m)| RtError::new(c, Kind::Type, m, span))?;
            o.borrow_mut().fields[i] = v;
            return Ok(());
        }
        if kind == ObjectKind::Document && name == "date" {
            let d = match v {
                Value::Date(d) => Some(d),
                Value::Null => None,
                v => return Err(RtError::new(codes::FIELD_TYPE, Kind::Type, format!("A document date is a Date, not {}.", v.kind_name()), span)),
            };
            o.borrow_mut().date = d;
            return Ok(());
        }
        let system = matches!(name, "id" | "version" | "deleted") || (kind == ObjectKind::Document && matches!(name, "number" | "status"));
        let rows = self.meta.document(&type_name).is_some_and(|d| d.rows.iter().any(|r| r.name == name));
        if system || rows {
            return Err(RtError::new(codes::READ_ONLY, Kind::Runtime, format!("\"{name}\" of {type_name} cannot be assigned."), span));
        }
        Err(Self::no_member(&Value::Object(o.clone()), name, span))
    }

    fn index_of(&self, i: &Value, len: usize, span: Span) -> RtResult<usize> {
        match i {
            Value::Int(n) if *n >= 0 && (*n as u64) < len as u64 => Ok(*n as usize),
            Value::Int(n) => Err(RtError::new(codes::INDEX_RANGE, Kind::Runtime, format!("Index {n} is out of range (length {len})."), span)),
            v => Err(RtError::new(codes::INDEX_TYPE, Kind::Type, format!("An index must be an Integer, not {}.", v.kind_name()), span)),
        }
    }

    pub(crate) fn get_index(&mut self, target: &Value, i: &Value, span: Span) -> RtResult<Value> {
        match target {
            Value::Array(a) => {
                let a = a.borrow();
                let ix = self.index_of(i, a.len(), span)?;
                Ok(a[ix].clone())
            }
            Value::Map(m) => match i {
                Value::Str(k) => Ok(m.borrow().get(k).cloned().unwrap_or(Value::Null)),
                v => Err(RtError::new(codes::INDEX_TYPE, Kind::Type, format!("Map keys are Strings, not {}.", v.kind_name()), span)),
            },
            Value::Rows(o, r) => {
                let o = o.borrow();
                let ix = self.index_of(i, o.rows[*r].len(), span)?;
                Ok(Value::Row(o.rows[*r][ix].clone()))
            }
            Value::Null => Err(RtError::new(codes::NULL_ACCESS, Kind::Runtime, "Cannot index null.", span)),
            v => Err(RtError::new(codes::INDEX_TYPE, Kind::Type, format!("{} cannot be indexed.", v.kind_name()), span)),
        }
    }

    fn set_index(&mut self, target: &Value, i: &Value, v: Value, span: Span) -> RtResult<()> {
        match target {
            Value::Array(a) => {
                let len = a.borrow().len();
                let ix = self.index_of(i, len, span)?;
                a.borrow_mut()[ix] = v;
                Ok(())
            }
            Value::Map(m) => match i {
                Value::Str(k) => {
                    let mut m = m.borrow_mut();
                    if m.insert(k.clone(), v) {
                        self.check_len(m.len(), span)?;
                        self.charge(48 + k.len(), span)?;
                    }
                    Ok(())
                }
                other => Err(RtError::new(codes::INDEX_TYPE, Kind::Type, format!("Map keys are Strings, not {}.", other.kind_name()), span)),
            },
            Value::Null => Err(RtError::new(codes::NULL_ACCESS, Kind::Runtime, "Cannot index null.", span)),
            other => Err(RtError::new(codes::INDEX_TYPE, Kind::Type, format!("Elements of {} cannot be assigned.", other.kind_name()), span)),
        }
    }

    // ----- business objects --------------------------------------------------------------

    pub(crate) fn new_row(&mut self, doc: &Rc<RefCell<Obj>>, rows_index: usize, span: Span) -> RtResult<Rc<RefCell<RowData>>> {
        let (type_name, lock, len) = {
            let d = doc.borrow();
            (d.type_name.clone(), d.lock, d.rows[rows_index].len())
        };
        self.check_writable(lock, &type_name, span)?;
        self.check_len(len + 1, span)?;
        let row = Rc::new(RefCell::new(convert::new_row(self.meta, doc, rows_index)));
        self.charge(64 + row.borrow().fields.len() * 32, span)?;
        let mut d = doc.borrow_mut();
        row.borrow_mut().line_no = d.rows[rows_index].len() as u32 + 1;
        d.rows[rows_index].push(row.clone());
        Ok(row)
    }

    pub(crate) fn renumber(doc: &Obj, rows_index: usize) {
        for (i, r) in doc.rows[rows_index].iter().enumerate() {
            r.borrow_mut().line_no = i as u32 + 1;
        }
    }

    pub(crate) fn obj_to_wire(&self, o: &Obj) -> vks_protocol::WireObject {
        obj_to_wire(o, self.meta)
    }

    pub(crate) fn obj_from_wire_value(&self, w: &WireValue, span: Span) -> RtResult<Option<Rc<RefCell<Obj>>>> {
        match w {
            WireValue::Null => Ok(None),
            WireValue::Object(o) => obj_from_wire(o, self.meta).map(Some).map_err(|m| RtError::new(codes::HOST, Kind::Host, format!("The platform returned invalid data: {m}."), span)),
            _ => Err(RtError::new(codes::HOST, Kind::Host, "The platform returned something other than an object.", span)),
        }
    }
}

pub(crate) fn host_error(e: HostError, span: Span) -> RtError {
    let (code, kind) = match e.code.as_str() {
        "permission" => (codes::PERMISSION, Kind::Permission),
        "rejected" => (codes::REJECTED, Kind::Rejected),
        "notFound" => (codes::HOST_NOT_FOUND, Kind::Host),
        "validation" => (codes::HOST_VALIDATION, Kind::Host),
        "conflict" => (codes::HOST_CONFLICT, Kind::Host),
        "unsupported" => (codes::HOST_UNSUPPORTED, Kind::Host),
        "limit" => (codes::EVENT_DEPTH, Kind::Limit),
        _ => (codes::HOST, Kind::Host),
    };
    RtError::new(code, kind, e.message, span)
}
