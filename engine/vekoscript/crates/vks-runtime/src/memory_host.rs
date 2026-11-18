//! An in-memory platform for tests, examples, benchmarks and `vks run`. It follows the rules
//! the Java platform enforces (handlers around save/post/reverse/delete, validation, unique
//! fields, optimistic versions, posting intents, active movements and balances) but keeps
//! everything in memory. It is a development tool, not a database.
//!
//! Each top-level host call is atomic: if anything fails, including a nested handler or
//! applying intents, the state is restored to what it was before the call.

use crate::convert::{coerce_field, fit_decimal, obj_from_wire};
use crate::{execute, Host, Program};
use rust_decimal::Decimal;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::str::FromStr;
use vks_metadata::{FieldType, MetadataModel, ObjectKind, RegisterType};
use vks_protocol::{Direction, Entry, ExecContext, ExecuteResult, HostCall, HostError, Intent, WireObject, WireValue};
use vks_syntax::ast::Event;

#[derive(Debug, Clone, PartialEq)]
pub struct Movement {
    pub register: String,
    pub recorder_type: String,
    pub recorder: String,
    pub period: String,
    pub line_no: u32,
    pub direction: Direction,
    pub active: bool,
    pub dimensions: BTreeMap<String, WireValue>,
    pub measures: BTreeMap<String, WireValue>,
}

#[derive(Default)]
struct State {
    /// (type, id) в†’ object, plus creation order.
    objects: HashMap<(String, String), WireObject>,
    order: Vec<(String, String)>,
    movements: Vec<Movement>,
    seq: u64,
    numbers: HashMap<String, u64>,
}

/// How to undo one change made during the current top-level operation.
enum Undo {
    /// Previous value of an object, and whether the key was appended to `order`.
    Object((String, String), Option<Box<WireObject>>, bool),
    MovementsLen(usize),
    Activated(usize),
    Seq(u64),
    Number(String, Option<u64>),
}

pub struct MemoryHost {
    program: Rc<Program>,
    state: State,
    /// Changes of the running top-level operation, undone if it fails.
    journal: Option<Vec<Undo>>,
    depth: u32,
    /// After* events waiting for the current top-level operation to commit.
    outbox: Vec<(String, Event, WireObject)>,
    /// Messages from notify() in handlers, and After* handler failures.
    pub notifications: Vec<String>,
    /// Test hook: make the next posting fail while applying its movements.
    pub fail_next_apply: bool,
}

fn err(code: &str, message: impl Into<String>) -> HostError {
    HostError { code: code.into(), message: message.into() }
}

fn prefix(type_name: &str) -> String {
    let p: String = type_name.chars().filter(|c| c.is_ascii_uppercase()).collect();
    if p.is_empty() {
        type_name.chars().take(2).collect::<String>().to_uppercase()
    } else {
        p
    }
}

fn add_wire(a: &WireValue, b: &WireValue, negate: bool) -> Result<WireValue, HostError> {
    match (a, b) {
        (WireValue::Int(x), WireValue::Int(y)) => {
            let y = if negate { y.checked_neg() } else { Some(*y) };
            y.and_then(|y| x.checked_add(y)).map(WireValue::Int).ok_or_else(|| err("validation", "Register total overflows."))
        }
        (WireValue::Dec(x), WireValue::Dec(y)) => {
            let (x, y) = (Decimal::from_str(x).map_err(|_| err("internal", "bad decimal"))?, Decimal::from_str(y).map_err(|_| err("internal", "bad decimal"))?);
            let r = if negate { x.checked_sub(y) } else { x.checked_add(y) };
            r.map(|r| WireValue::Dec(r.to_string())).ok_or_else(|| err("validation", "Register total overflows."))
        }
        _ => Err(err("internal", "mismatched register values")),
    }
}

impl MemoryHost {
    pub fn new(program: Rc<Program>) -> Self {
        MemoryHost { program, state: State::default(), journal: None, depth: 0, outbox: Vec::new(), notifications: Vec::new(), fail_next_apply: false }
    }

    fn record(&mut self, u: Undo) {
        if let Some(j) = &mut self.journal {
            j.push(u);
        }
    }

    fn rollback(&mut self, journal: Vec<Undo>) {
        for u in journal.into_iter().rev() {
            match u {
                Undo::Object(key, previous, appended) => {
                    if appended {
                        self.state.order.pop();
                    }
                    match previous {
                        Some(o) => self.state.objects.insert(key, *o),
                        None => self.state.objects.remove(&key),
                    };
                }
                Undo::MovementsLen(n) => self.state.movements.truncate(n),
                Undo::Activated(i) => {
                    if let Some(m) = self.state.movements.get_mut(i) {
                        m.active = true;
                    }
                }
                Undo::Seq(s) => self.state.seq = s,
                Undo::Number(t, n) => match n {
                    Some(n) => {
                        self.state.numbers.insert(t, n);
                    }
                    None => {
                        self.state.numbers.remove(&t);
                    }
                },
            }
        }
    }

    pub fn metadata(&self) -> &MetadataModel {
        &self.program.metadata
    }

    pub fn movements(&self) -> &[Movement] {
        &self.state.movements
    }

    pub fn objects(&self, type_name: &str) -> Vec<&WireObject> {
        self.state.order.iter().filter(|k| k.0 == type_name).filter_map(|k| self.state.objects.get(k)).collect()
    }

    pub fn get(&self, type_name: &str, id: &str) -> Option<&WireObject> {
        self.state.objects.get(&(type_name.to_string(), id.to_string()))
    }

    fn run_handler(&mut self, ctx: &ExecContext, target: &str, event: Event, object: WireObject) -> Result<ExecuteResult, HostError> {
        let program = self.program.clone();
        if program.handler(target, event).is_none() {
            return Ok(ExecuteResult { ok: true, value: None, object: Some(object), intents: Vec::new(), logs: Vec::new(), error: None, stats: Default::default() });
        }
        let mut nested = ctx.clone();
        nested.event_depth += 1;
        nested.operation = format!("{target}.{}", event.name());
        let r = execute(&program, &nested, &Entry::Handler { target: target.to_string(), event, object }, self);
        for l in &r.logs {
            if l.level == "notify" {
                self.notifications.push(l.message.clone());
            }
        }
        match &r.error {
            None => Ok(r),
            Some(e) => {
                let code = match e.kind.as_str() {
                    "rejected" => "rejected",
                    "permission" => "permission",
                    "limit" => "limit",
                    _ => "validation",
                };
                let message = if code == "rejected" { e.message.clone() } else { format!("{target}.{} failed at {}:{}: {}", event.name(), e.line, e.col, e.message) };
                Err(err(code, message))
            }
        }
    }

    /// Platform-side validation of an object about to be stored.
    fn validate(&self, o: &WireObject) -> Result<(), HostError> {
        let meta = &self.program.metadata;
        obj_from_wire(o, meta).map_err(|m| err("validation", m))?;
        let fields = meta.object_fields(&o.type_name).unwrap_or(&[]);
        for f in fields {
            let v = o.fields.get(&f.name).unwrap_or(&WireValue::Null);
            if f.required && *v == WireValue::Null {
                return Err(err("validation", format!("{}: \"{}\" is required.", o.type_name, f.name)));
            }
            if let WireValue::Ref { type_name, id, .. } = v {
                if !self.state.objects.contains_key(&(type_name.clone(), id.clone())) {
                    return Err(err("validation", format!("{}: \"{}\" refers to {type_name}({id}), which does not exist.", o.type_name, f.name)));
                }
            }
            if f.unique && *v != WireValue::Null {
                let clash = self.state.objects.values().any(|x| x.type_name == o.type_name && x.id != o.id && !x.deleted && x.fields.get(&f.name) == Some(v));
                if clash {
                    return Err(err(
                        "validation",
                        format!("{}: another record already has {} {}.", o.type_name, f.name, crate::convert::wire_to_value(v, meta).map(|v| v.display()).unwrap_or_default()),
                    ));
                }
            }
        }
        if let Some(doc) = meta.document(&o.type_name) {
            for rm in &doc.rows {
                for (i, row) in o.rows.get(&rm.name).map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
                    for f in &rm.fields {
                        let v = row.fields.get(&f.name).unwrap_or(&WireValue::Null);
                        if f.required && *v == WireValue::Null {
                            return Err(err("validation", format!("{} {} line {}: \"{}\" is required.", o.type_name, rm.name, i + 1, f.name)));
                        }
                        if let WireValue::Ref { type_name, id, .. } = v {
                            if !self.state.objects.contains_key(&(type_name.clone(), id.clone())) {
                                return Err(err("validation", format!("{} {} line {}: \"{}\" refers to {type_name}({id}), which does not exist.", o.type_name, rm.name, i + 1, f.name)));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn stored(&self, type_name: &str, id: &str) -> Result<WireObject, HostError> {
        match self.state.objects.get(&(type_name.to_string(), id.to_string())) {
            Some(o) if !o.deleted => Ok(o.clone()),
            _ => Err(err("notFound", format!("{type_name}({id}) does not exist."))),
        }
    }

    fn put(&mut self, o: WireObject) {
        let key = (o.type_name.clone(), o.id.clone().expect("stored objects have ids"));
        let appended = !self.state.objects.contains_key(&key);
        if appended {
            self.state.order.push(key.clone());
        }
        let previous = self.state.objects.insert(key.clone(), o);
        self.record(Undo::Object(key, previous.map(Box::new), appended));
    }

    fn today(ctx: &ExecContext) -> String {
        crate::convert::parse_datetime(&ctx.now).map(|d| d.date().format("%Y-%m-%d").to_string()).unwrap_or_else(|| chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string())
    }

    fn save(&mut self, ctx: &ExecContext, mut o: WireObject) -> Result<WireValue, HostError> {
        let meta = self.program.metadata.clone();
        if meta.object_kind(&o.type_name) != Some(o.kind) {
            return Err(err("validation", format!("Unknown {:?} {}.", o.kind, o.type_name)));
        }
        let is_new = o.id.is_none();
        if let Some(id) = &o.id {
            let current = self.stored(&o.type_name, id)?;
            if current.version != o.version {
                return Err(err("conflict", format!("{} was changed by someone else (version {:?}, yours {:?}); reload it.", o.type_name, current.version, o.version)));
            }
            if current.status.as_deref() == Some("posted") {
                return Err(err("conflict", format!("{} {} is posted; reverse it before changing it.", o.type_name, current.number.unwrap_or_default())));
            }
        }
        let target = o.type_name.clone();
        if is_new {
            o = self.run_handler(ctx, &target, Event::BeforeCreate, o)?.object.expect("handler returns its object");
        }
        o = self.run_handler(ctx, &target, Event::BeforeSave, o)?.object.expect("handler returns its object");
        if o.kind == ObjectKind::Document {
            // Line numbers are the platform's.
            for rows in o.rows.values_mut() {
                for (i, r) in rows.iter_mut().enumerate() {
                    r.line_no = Some(i as u32 + 1);
                }
            }
            if o.date.is_none() {
                o.date = Some(Self::today(ctx));
            }
            if o.status.is_none() {
                o.status = Some("draft".into());
            }
        }
        self.validate(&o)?;
        if is_new {
            self.record(Undo::Seq(self.state.seq));
            self.state.seq += 1;
            o.id = Some(format!("{}-{}", prefix(&target).to_lowercase(), self.state.seq));
            o.version = Some(1);
            if o.kind == ObjectKind::Document {
                let previous = self.state.numbers.get(&target).copied();
                self.record(Undo::Number(target.clone(), previous));
                let n = previous.unwrap_or(0) + 1;
                self.state.numbers.insert(target.clone(), n);
                o.number = Some(format!("{}-{:06}", prefix(&target), n));
            }
        } else {
            o.version = Some(o.version.unwrap_or(0) + 1);
        }
        self.put(o.clone());
        self.outbox.push((target.clone(), if is_new { Event::AfterCreate } else { Event::AfterSave }, o.clone()));
        Ok(WireValue::Object(Box::new(o)))
    }

    fn check_movement(&self, intent: &Intent) -> Result<(), HostError> {
        let meta = &self.program.metadata;
        let Intent::RegisterMovement { register, dimensions, measures, .. } = intent else {
            return Err(err("unsupported", "Accounting entries are not supported by this platform yet."));
        };
        let reg = meta.register(register).ok_or_else(|| err("validation", format!("Unknown register {register}.")))?;
        if reg.ty != RegisterType::Accumulation {
            return Err(err("validation", format!("{register} is not an accumulation register.")));
        }
        for d in &reg.dimensions {
            let v = dimensions.get(&d.name).ok_or_else(|| err("validation", format!("{register}: dimension {} is missing.", d.name)))?;
            let value = crate::convert::wire_to_value(v, meta).map_err(|m| err("validation", m))?;
            if matches!(coerce_field(d, value), Err(_) | Ok(crate::value::Value::Null)) {
                return Err(err("validation", format!("{register}: dimension {} has an invalid value.", d.name)));
            }
            if let WireValue::Ref { type_name, id, .. } = v {
                if !self.state.objects.contains_key(&(type_name.clone(), id.clone())) {
                    return Err(err("validation", format!("{register}: {} refers to {type_name}({id}), which does not exist.", d.name)));
                }
            }
        }
        for k in dimensions.keys() {
            if !reg.dimensions.iter().any(|d| &d.name == k) {
                return Err(err("validation", format!("{register} has no dimension {k}.")));
            }
        }
        for (k, v) in measures {
            let m = reg.values.iter().find(|m| &m.name == k).ok_or_else(|| err("validation", format!("{register} has no measure {k}.")))?;
            let ok = match (&m.ty, v) {
                (FieldType::Decimal { precision, scale }, WireValue::Dec(s)) => Decimal::from_str(s).ok().is_some_and(|d| fit_decimal(d, *precision, *scale).is_ok()),
                (FieldType::Integer, WireValue::Int(_)) => true,
                _ => false,
            };
            if !ok {
                return Err(err("validation", format!("{register}: measure {k} does not fit {}.", m.ty.describe())));
            }
        }
        Ok(())
    }

    fn post(&mut self, ctx: &ExecContext, type_name: &str, id: &str) -> Result<WireValue, HostError> {
        let mut doc = self.stored(type_name, id)?;
        if doc.kind != ObjectKind::Document {
            return Err(err("validation", format!("{type_name} is not a document.")));
        }
        if doc.status.as_deref() == Some("posted") {
            return Err(err("conflict", format!("{type_name} {} is already posted.", doc.number.clone().unwrap_or_default())));
        }
        self.run_handler(ctx, type_name, Event::BeforePost, doc.clone())?;
        let result = self.run_handler(ctx, type_name, Event::Post, doc.clone())?;
        for i in &result.intents {
            self.check_movement(i)?;
        }
        let period = doc.date.clone().unwrap_or_else(|| Self::today(ctx));
        self.record(Undo::MovementsLen(self.state.movements.len()));
        for (n, i) in result.intents.into_iter().enumerate() {
            if n == 1 && self.fail_next_apply {
                // Fail after part of the movements were written: the journal must undo them.
                self.fail_next_apply = false;
                return Err(err("internal", "Simulated storage failure while applying movements."));
            }
            if let Intent::RegisterMovement { register, direction, dimensions, measures } = i {
                self.state.movements.push(Movement {
                    register,
                    recorder_type: type_name.into(),
                    recorder: id.into(),
                    period: period.clone(),
                    line_no: n as u32 + 1,
                    direction,
                    active: true,
                    dimensions,
                    measures,
                });
            }
        }
        doc.status = Some("posted".into());
        doc.version = Some(doc.version.unwrap_or(0) + 1);
        self.put(doc.clone());
        self.outbox.push((type_name.into(), Event::AfterPost, doc.clone()));
        Ok(WireValue::Object(Box::new(doc)))
    }

    fn reverse(&mut self, ctx: &ExecContext, type_name: &str, id: &str) -> Result<WireValue, HostError> {
        let mut doc = self.stored(type_name, id)?;
        if doc.status.as_deref() != Some("posted") {
            return Err(err("conflict", format!("{type_name} {} is not posted.", doc.number.clone().unwrap_or_default())));
        }
        self.run_handler(ctx, type_name, Event::BeforeReverse, doc.clone())?;
        let reversed: Vec<usize> = self.state.movements.iter().enumerate().filter(|(_, m)| m.active && m.recorder_type == type_name && m.recorder == id).map(|(i, _)| i).collect();
        for i in reversed {
            self.state.movements[i].active = false;
            self.record(Undo::Activated(i));
        }
        doc.status = Some("reversed".into());
        doc.version = Some(doc.version.unwrap_or(0) + 1);
        self.put(doc.clone());
        self.outbox.push((type_name.into(), Event::AfterReverse, doc.clone()));
        Ok(WireValue::Object(Box::new(doc)))
    }

    fn delete(&mut self, ctx: &ExecContext, type_name: &str, id: &str) -> Result<WireValue, HostError> {
        let mut o = self.stored(type_name, id)?;
        if o.status.as_deref() == Some("posted") {
            return Err(err("conflict", format!("{type_name} {} is posted; reverse it before deleting it.", o.number.clone().unwrap_or_default())));
        }
        self.run_handler(ctx, type_name, Event::BeforeDelete, o.clone())?;
        o.deleted = true;
        o.version = Some(o.version.unwrap_or(0) + 1);
        self.put(o.clone());
        self.outbox.push((type_name.into(), Event::AfterDelete, o));
        Ok(WireValue::Null)
    }

    fn matches(o: &WireObject, field: &str, value: &WireValue) -> bool {
        match field {
            "number" => matches!(value, WireValue::Str(s) if o.number.as_deref() == Some(s.as_str())),
            "id" => matches!(value, WireValue::Str(s) if o.id.as_deref() == Some(s.as_str())),
            f => o.fields.get(f).unwrap_or(&WireValue::Null) == value,
        }
    }

    fn balance(&self, register: &str, filter: &BTreeMap<String, WireValue>, at: Option<&str>) -> Result<WireValue, HostError> {
        let meta = &self.program.metadata;
        let reg = meta.register(register).ok_or_else(|| err("validation", format!("Unknown register {register}.")))?;
        if reg.ty != RegisterType::Accumulation {
            return Err(err("unsupported", format!("{register} is an information register; queries on information registers are not supported yet.")));
        }
        let mut totals: Vec<(String, WireValue)> = reg
            .values
            .iter()
            .map(|m| {
                let zero = match m.ty {
                    FieldType::Decimal { scale, .. } => {
                        let mut z = Decimal::ZERO;
                        z.rescale(scale);
                        WireValue::Dec(z.to_string())
                    }
                    _ => WireValue::Int(0),
                };
                (m.name.clone(), zero)
            })
            .collect();
        let at = at.map(|a| &a[..a.len().min(10)]);
        for m in self.state.movements.iter().filter(|m| m.register == register && m.active) {
            if at.is_some_and(|a| m.period.as_str() > a) {
                continue;
            }
            if filter.iter().any(|(k, v)| m.dimensions.get(k) != Some(v)) {
                continue;
            }
            for (name, total) in totals.iter_mut() {
                if let Some(v) = m.measures.get(name) {
                    *total = add_wire(total, v, m.direction == Direction::Out)?;
                }
            }
        }
        Ok(WireValue::Map(totals))
    }

    fn dispatch(&mut self, call: HostCall, ctx: &ExecContext) -> Result<WireValue, HostError> {
        match call {
            // References keep working after a record is archived; it reads as deleted.
            HostCall::FindById { type_name, id, .. } => Ok(self.state.objects.get(&(type_name, id)).map(|o| WireValue::Object(Box::new(o.clone()))).unwrap_or(WireValue::Null)),
            HostCall::FindBy { type_name, field, value, .. } => {
                let found = self.state.order.iter().filter(|k| k.0 == type_name).filter_map(|k| self.state.objects.get(k)).find(|o| !o.deleted && Self::matches(o, &field, &value));
                Ok(found.map(|o| WireValue::Object(Box::new(o.clone()))).unwrap_or(WireValue::Null))
            }
            HostCall::List { type_name, filter, limit, offset, .. } => {
                let items = self
                    .state
                    .order
                    .iter()
                    .filter(|k| k.0 == type_name)
                    .filter_map(|k| self.state.objects.get(k))
                    .filter(|o| !o.deleted && filter.iter().all(|(f, v)| Self::matches(o, f, v)))
                    .skip(offset as usize)
                    .take(limit as usize)
                    .map(|o| WireValue::Object(Box::new(o.clone())))
                    .collect();
                Ok(WireValue::Array(items))
            }
            HostCall::Save { object } => self.save(ctx, object),
            HostCall::Delete { type_name, id, .. } => self.delete(ctx, &type_name, &id),
            HostCall::Post { type_name, id } => self.post(ctx, &type_name, &id),
            HostCall::Reverse { type_name, id } => self.reverse(ctx, &type_name, &id),
            HostCall::RegisterBalance { register, dimensions, at } => self.balance(&register, &dimensions, at.as_deref()),
        }
    }
}

impl Host for MemoryHost {
    fn call(&mut self, call: HostCall, ctx: &ExecContext) -> Result<WireValue, HostError> {
        if !ctx.can(call.capability()) {
            return Err(err("permission", format!("{} may not perform this operation (needs \"{}\").", ctx.user, call.capability())));
        }
        let top = self.depth == 0;
        if top {
            self.journal = Some(Vec::new());
        }
        self.depth += 1;
        let r = self.dispatch(call, ctx);
        self.depth -= 1;
        if !top {
            return r;
        }
        let journal = self.journal.take().unwrap_or_default();
        match &r {
            Err(_) => {
                self.rollback(journal);
                self.outbox.clear();
            }
            Ok(_) => {
                // Committed: deliver After* events. Their failures cannot undo the commit.
                for (target, event, object) in std::mem::take(&mut self.outbox) {
                    self.depth += 1;
                    let r = self.run_handler(ctx, &target, event, object);
                    self.depth -= 1;
                    if let Err(e) = r {
                        self.notifications.push(format!("{target}.{} failed: {}", event.name(), e.message));
                    }
                    self.outbox.clear();
                }
            }
        }
        r
    }
}
