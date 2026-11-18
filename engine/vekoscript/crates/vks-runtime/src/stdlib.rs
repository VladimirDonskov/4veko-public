//! The standard library: built-in functions and methods on values, business objects, rows and
//! platform services.

use crate::builtins::Builtin;
use crate::convert::{coerce_field, new_obj, parse_date, parse_datetime, valid_currency};
use crate::error::{codes, RtError, RtResult};
use crate::interp::{Arg, Interp};
use crate::ops::{arith, compare};
use crate::value::{FuncVal, Lock, LockReason, Obj, RefVal, Root, Service, Status, Value};
use chrono::{Datelike, Duration as ChronoDuration, Months, NaiveDate, Timelike};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::str::FromStr;
use vks_metadata::{FieldType, ObjectKind, RegisterType};
use vks_protocol::{Direction, HostCall, Intent, LogEntry, WireValue};
use vks_syntax::ast::BinaryOp;
use vks_syntax::{Kind, Span};

fn conv(msg: String, span: Span) -> RtError {
    RtError::new(codes::CONVERSION, Kind::Runtime, msg, span)
}

fn arg_type(what: &str, expected: &str, v: &Value, span: Span) -> RtError {
    RtError::new(codes::ARGS, Kind::Type, format!("{what} expects {expected}, not {}.", v.kind_name()), span)
}

fn want_int(what: &str, v: &Value, span: Span) -> RtResult<i64> {
    match v {
        Value::Int(i) => Ok(*i),
        v => Err(arg_type(what, "an Integer", v, span)),
    }
}

fn want_str(what: &str, v: &Value, span: Span) -> RtResult<Rc<str>> {
    match v {
        Value::Str(s) => Ok(s.clone()),
        v => Err(arg_type(what, "a String", v, span)),
    }
}

fn want_num(what: &str, v: &Value, span: Span) -> RtResult<Decimal> {
    match v {
        Value::Int(i) => Ok(Decimal::from(*i)),
        Value::Dec(d) => Ok(*d),
        v => Err(arg_type(what, "a number", v, span)),
    }
}

fn round_value(v: &Value, places: Option<&Value>, mode: Option<&Value>, span: Span) -> RtResult<Value> {
    let places = match places {
        None | Some(Value::Null) => 0,
        Some(Value::Int(p)) if (0..=28).contains(p) => *p as u32,
        Some(p) => return Err(RtError::new(codes::ARGS, Kind::Type, format!("round() places must be an Integer from 0 to 28, not {}.", p.display()), span)),
    };
    let strategy = match mode {
        None | Some(Value::Null) => RoundingStrategy::MidpointAwayFromZero,
        Some(Value::Str(m)) if &**m == "away" => RoundingStrategy::MidpointAwayFromZero,
        Some(Value::Str(m)) if &**m == "even" => RoundingStrategy::MidpointNearestEven,
        Some(m) => return Err(RtError::new(codes::ARGS, Kind::Type, format!("round() mode is \"away\" or \"even\", not {}.", m.display()), span)),
    };
    match v {
        Value::Int(i) => Ok(Value::Int(*i)),
        Value::Dec(d) => Ok(Value::Dec(d.round_dp_with_strategy(places, strategy))),
        Value::Money(a, c) => Ok(Value::Money(a.round_dp_with_strategy(places, strategy), c.clone())),
        v => Err(arg_type("round()", "a number or Money", v, span)),
    }
}

fn abs_value(v: &Value, span: Span) -> RtResult<Value> {
    match v {
        Value::Int(i) => i.checked_abs().map(Value::Int).ok_or_else(|| RtError::new(codes::INT_OVERFLOW, Kind::Runtime, "Integer overflow in abs().", span)),
        Value::Dec(d) => Ok(Value::Dec(d.abs())),
        Value::Money(a, c) => Ok(Value::Money(a.abs(), c.clone())),
        Value::Duration(s) => s.checked_abs().map(Value::Duration).ok_or_else(|| RtError::new(codes::INT_OVERFLOW, Kind::Runtime, "Overflow in abs().", span)),
        v => Err(arg_type("abs()", "a number, Money or Duration", v, span)),
    }
}

fn format_template(template: &str, args: &[Value], span: Span) -> RtResult<String> {
    let mut out = String::with_capacity(template.len() + 16);
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                out.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                out.push('}');
            }
            '{' => {
                let mut digits = String::new();
                for d in chars.by_ref() {
                    if d == '}' {
                        break;
                    }
                    digits.push(d);
                }
                let i: usize = digits
                    .parse()
                    .map_err(|_| RtError::new(codes::ARGS, Kind::Runtime, format!("format(): \"{{{digits}}}\" is not a placeholder like {{0}}; write {{{{ for a literal brace."), span))?;
                let v = args.get(i).ok_or_else(|| RtError::new(codes::ARGS, Kind::Runtime, format!("format(): placeholder {{{i}}} has no argument."), span))?;
                out.push_str(&v.display());
            }
            c => out.push(c),
        }
    }
    Ok(out)
}

fn date_add_months(d: NaiveDate, n: i64, span: Span) -> RtResult<NaiveDate> {
    let err = || RtError::new(codes::DATE_MATH, Kind::Runtime, "Date is out of range.", span);
    let m = u32::try_from(n.unsigned_abs()).map_err(|_| err())?;
    if n >= 0 {
        d.checked_add_months(Months::new(m)).ok_or_else(err)
    } else {
        d.checked_sub_months(Months::new(m)).ok_or_else(err)
    }
}

impl Interp<'_> {
    fn no_method(v: &Value, name: &str, span: Span) -> RtError {
        if matches!(v, Value::Null) {
            return RtError::new(codes::NULL_ACCESS, Kind::Runtime, format!("Cannot call {name}() on null."), span);
        }
        RtError::new(codes::NO_MEMBER, Kind::Type, format!("{} has no method \"{name}\".", v.type_name()), span)
    }

    fn params(&self, what: &str, params: &[&str], required: usize, args: Vec<Arg>, span: Span) -> RtResult<Vec<Option<Value>>> {
        Ok(self.bind(what, params, required, false, args, span)?.0)
    }

    fn none(&self, what: &str, args: Vec<Arg>, span: Span) -> RtResult<()> {
        self.bind(what, &[], 0, false, args, span).map(|_| ())
    }

    // ----- built-in functions ------------------------------------------------------------

    pub(crate) fn call_builtin(&mut self, b: Builtin, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let sig = b.signature();
        let (slots, extra) = self.bind(b.name(), sig.params, sig.required, sig.variadic, args, span)?;
        let arg = |i: usize| slots.get(i).cloned().flatten();
        let first = || arg(0).unwrap_or(Value::Null);
        match b {
            Builtin::Str => {
                let s = first().display();
                self.new_str(s, span)
            }
            Builtin::Int => match first() {
                Value::Int(i) => Ok(Value::Int(i)),
                Value::Dec(d) if d.fract().is_zero() => d.to_i64().map(Value::Int).ok_or_else(|| conv(format!("{d} does not fit in an Integer."), span)),
                Value::Dec(d) => Err(conv(format!("{d} has a fraction; round it first, e.g. int(round(x, 0))."), span)),
                Value::Str(s) => s.trim().parse::<i64>().map(Value::Int).map_err(|_| conv(format!("\"{s}\" is not a whole number."), span)),
                v => Err(conv(format!("Cannot convert {} to Integer.", v.kind_name()), span)),
            },
            Builtin::Decimal => match first() {
                Value::Int(i) => Ok(Value::Dec(Decimal::from(i))),
                Value::Dec(d) => Ok(Value::Dec(d)),
                Value::Money(a, _) => Ok(Value::Dec(a)),
                Value::Str(s) => {
                    let t = s.trim();
                    if t.contains(['e', 'E']) {
                        return Err(conv(format!("\"{s}\" uses an exponent; write the number out."), span));
                    }
                    Decimal::from_str(t).map(Value::Dec).map_err(|_| conv(format!("\"{s}\" is not a decimal number."), span))
                }
                v => Err(conv(format!("Cannot convert {} to Decimal.", v.kind_name()), span)),
            },
            Builtin::Bool => match first() {
                Value::Bool(b) => Ok(Value::Bool(b)),
                Value::Str(s) if &*s == "true" => Ok(Value::Bool(true)),
                Value::Str(s) if &*s == "false" => Ok(Value::Bool(false)),
                v => Err(conv(format!("Cannot convert {} to Boolean; only \"true\" and \"false\" convert.", v.display()), span)),
            },
            Builtin::Round => round_value(&first(), arg(1).as_ref(), arg(2).as_ref(), span),
            Builtin::Abs => abs_value(&first(), span),
            Builtin::Min | Builtin::Max => {
                let mut best = first();
                for v in std::iter::once(arg(1).unwrap_or(Value::Null)).chain(extra) {
                    let ord = compare(&v, &best, span)?;
                    if (b == Builtin::Min && ord == Ordering::Less) || (b == Builtin::Max && ord == Ordering::Greater) {
                        best = v;
                    }
                }
                Ok(best)
            }
            Builtin::Date => {
                if arg(1).is_some() || arg(2).is_some() {
                    let y = want_int("date()", &first(), span)?;
                    let m = want_int("date()", &arg(1).unwrap_or(Value::Null), span)?;
                    let d = want_int("date()", &arg(2).unwrap_or(Value::Null), span)?;
                    let ok = |x: i64, lo: i64, hi: i64| (lo..=hi).contains(&x);
                    return (ok(y, 1, 9999) && ok(m, 1, 12) && ok(d, 1, 31))
                        .then(|| NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32))
                        .flatten()
                        .map(Value::Date)
                        .ok_or_else(|| conv(format!("{y}-{m}-{d} is not a valid date."), span));
                }
                match first() {
                    Value::Str(s) => parse_date(&s).map(Value::Date).ok_or_else(|| conv(format!("\"{s}\" is not a date; use YYYY-MM-DD."), span)),
                    Value::Date(d) => Ok(Value::Date(d)),
                    Value::DateTime(d) => Ok(Value::Date(d.date())),
                    v => Err(conv(format!("Cannot convert {} to Date.", v.kind_name()), span)),
                }
            }
            Builtin::DateTime => match first() {
                Value::Str(s) => parse_datetime(&s).map(Value::DateTime).ok_or_else(|| conv(format!("\"{s}\" is not a date-time; use 2026-10-28T14:30:00Z."), span)),
                Value::Date(d) => Ok(Value::DateTime(d.and_hms_opt(0, 0, 0).expect("midnight exists"))),
                Value::DateTime(d) => Ok(Value::DateTime(d)),
                v => Err(conv(format!("Cannot convert {} to DateTime.", v.kind_name()), span)),
            },
            Builtin::Now => Ok(Value::DateTime(self.now)),
            Builtin::Today => Ok(Value::Date(self.now.date())),
            Builtin::Days | Builtin::Hours | Builtin::Minutes | Builtin::Seconds => {
                let n = want_int(b.name(), &first(), span)?;
                let unit = match b {
                    Builtin::Days => 86_400,
                    Builtin::Hours => 3_600,
                    Builtin::Minutes => 60,
                    _ => 1,
                };
                n.checked_mul(unit).map(Value::Duration).ok_or_else(|| RtError::new(codes::INT_OVERFLOW, Kind::Runtime, "Duration is out of range.", span))
            }
            Builtin::Money => {
                let amount = want_num("money()", &first(), span)?;
                let currency = want_str("money()", &arg(1).unwrap_or(Value::Null), span)?;
                if !valid_currency(&currency) {
                    return Err(conv(format!("\"{currency}\" is not a currency code; use three capital letters, e.g. \"USD\"."), span));
                }
                Ok(Value::Money(amount, currency))
            }
            Builtin::Format => {
                let template = want_str("format()", &first(), span)?;
                let s = format_template(&template, &extra, span)?;
                self.new_str(s, span)
            }
            Builtin::TypeOf => Ok(Value::str(&first().type_name())),
            Builtin::Reject => Err(RtError::new(codes::REJECTED, Kind::Rejected, first().display(), span)),
            Builtin::Notify | Builtin::Log => {
                let level = if b == Builtin::Notify { "notify" } else { "info" };
                self.check_len(self.logs.len() + 1, span)?;
                let message = first().display();
                self.charge(message.len() + 64, span)?;
                self.logs.push(LogEntry { level: level.into(), message, line: span.line, col: span.col });
                Ok(Value::Null)
            }
            Builtin::Range => {
                let a = want_int("range()", &first(), span)?;
                let (start, end) = match arg(1) {
                    Some(e) => (a, want_int("range()", &e, span)?),
                    None => (0, a),
                };
                let len = end.saturating_sub(start).max(0) as u64;
                self.check_len(usize::try_from(len).unwrap_or(usize::MAX), span)?;
                let items = (start..end).map(Value::Int).collect();
                self.new_array(items, span)
            }
        }
    }

    // ----- methods -----------------------------------------------------------------------

    pub(crate) fn call_method(&mut self, recv: Value, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        match &recv {
            Value::Str(s) => self.str_method(s.clone(), name, args, span),
            Value::Int(_) | Value::Dec(_) | Value::Money(..) => match name {
                "round" => {
                    let p = self.params("round()", &["places", "mode"], 0, args, span)?;
                    round_value(&recv, p[0].as_ref(), p[1].as_ref(), span)
                }
                "abs" => {
                    self.none("abs()", args, span)?;
                    abs_value(&recv, span)
                }
                _ => Err(Self::no_method(&recv, name, span)),
            },
            Value::Date(d) => self.date_method(*d, name, args, span),
            Value::DateTime(d) => {
                self.none(name, args, span)?;
                Ok(match name {
                    "date" => Value::Date(d.date()),
                    "year" => Value::Int(d.year() as i64),
                    "month" => Value::Int(d.month() as i64),
                    "day" => Value::Int(d.day() as i64),
                    "hour" => Value::Int(d.hour() as i64),
                    "minute" => Value::Int(d.minute() as i64),
                    "second" => Value::Int(d.second() as i64),
                    _ => return Err(Self::no_method(&recv, name, span)),
                })
            }
            Value::Duration(s) => {
                self.none(name, args, span)?;
                Ok(match name {
                    "totalSeconds" => Value::Int(*s),
                    "totalDays" => Value::Dec(Decimal::from(*s) / Decimal::from(86_400)),
                    _ => return Err(Self::no_method(&recv, name, span)),
                })
            }
            Value::Array(a) => self.array_method(&recv, a.clone(), name, args, span),
            Value::Map(m) => self.map_method(m.clone(), name, args, span),
            Value::Object(o) => self.object_method(o.clone(), name, args, span),
            Value::Ref(r) => match name {
                "load" => {
                    self.none("load()", args, span)?;
                    Ok(Value::Object(self.load(r, span)?))
                }
                _ => Err(Self::no_method(&recv, name, span)),
            },
            Value::Rows(o, i) => self.rows_method(o.clone(), *i, name, args, span),
            Value::Service(Service::Manager(root, type_name)) => self.manager_method(*root, type_name.clone(), name, args, span),
            Value::Service(Service::Root(Root::Context)) if name == "can" => {
                let p = self.params("Context.can()", &["capability"], 1, args, span)?;
                let cap = want_str("Context.can()", p[0].as_ref().unwrap_or(&Value::Null), span)?;
                Ok(Value::Bool(self.ctx.can(&cap)))
            }
            Value::Func(f) => {
                let what = match f {
                    FuncVal::Builtin(b) => b.name().to_string(),
                    FuncVal::User(i) => self.prog.functions[*i as usize].name.to_string(),
                };
                Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("Function {what} has no methods; call it directly."), span))
            }
            _ => Err(Self::no_method(&recv, name, span)),
        }
    }

    fn str_method(&mut self, s: Rc<str>, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let what = format!("String.{name}()");
        let text = |p: &Option<Value>| -> RtResult<Rc<str>> { want_str(&what, p.as_ref().unwrap_or(&Value::Null), span) };
        match name {
            "length" => {
                self.none(&what, args, span)?;
                Ok(Value::Int(s.chars().count() as i64))
            }
            "isEmpty" => {
                self.none(&what, args, span)?;
                Ok(Value::Bool(s.is_empty()))
            }
            "upper" | "lower" | "trim" => {
                self.none(&what, args, span)?;
                let out = match name {
                    "upper" => s.to_uppercase(),
                    "lower" => s.to_lowercase(),
                    _ => s.trim().to_string(),
                };
                self.new_str(out, span)
            }
            "contains" | "startsWith" | "endsWith" | "indexOf" => {
                let p = self.params(&what, &["text"], 1, args, span)?;
                let t = text(&p[0])?;
                Ok(match name {
                    "contains" => Value::Bool(s.contains(&*t)),
                    "startsWith" => Value::Bool(s.starts_with(&*t)),
                    "endsWith" => Value::Bool(s.ends_with(&*t)),
                    _ => Value::Int(s.find(&*t).map(|b| s[..b].chars().count() as i64).unwrap_or(-1)),
                })
            }
            "substring" => {
                let p = self.params(&what, &["start", "end"], 1, args, span)?;
                let len = s.chars().count() as i64;
                let start = want_int(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                let end = match &p[1] {
                    None | Some(Value::Null) => len,
                    Some(v) => want_int(&what, v, span)?,
                };
                if start < 0 || end < start || end > len {
                    return Err(RtError::new(codes::INDEX_RANGE, Kind::Runtime, format!("substring({start}, {end}) is outside a text of length {len}."), span));
                }
                let out: String = s.chars().skip(start as usize).take((end - start) as usize).collect();
                self.new_str(out, span)
            }
            "replace" => {
                let p = self.params(&what, &["from", "to"], 2, args, span)?;
                let (from, to) = (text(&p[0])?, text(&p[1])?);
                if from.is_empty() {
                    return Err(RtError::new(codes::ARGS, Kind::Runtime, "replace() needs a non-empty text to find.", span));
                }
                let count = s.matches(&*from).count();
                let projected = s.len() + count.saturating_mul(to.len());
                if projected > self.limits.max_string_bytes {
                    return Err(RtError::new(codes::STRING, Kind::Limit, format!("A string would exceed {} bytes.", self.limits.max_string_bytes), span));
                }
                let out = s.replace(&*from, &to);
                self.new_str(out, span)
            }
            "split" => {
                let p = self.params(&what, &["separator"], 1, args, span)?;
                let sep = text(&p[0])?;
                if sep.is_empty() {
                    return Err(RtError::new(codes::ARGS, Kind::Runtime, "split() needs a non-empty separator.", span));
                }
                let parts: Vec<Value> = s.split(&*sep).map(Value::str).collect();
                self.charge(s.len(), span)?;
                self.new_array(parts, span)
            }
            _ => Err(Self::no_method(&Value::Str(s), name, span)),
        }
    }

    fn date_method(&mut self, d: NaiveDate, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let what = format!("Date.{name}()");
        match name {
            "addDays" | "addMonths" => {
                let p = self.params(&what, &["count"], 1, args, span)?;
                let n = want_int(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                let r = if name == "addDays" {
                    ChronoDuration::try_days(n).and_then(|x| d.checked_add_signed(x)).ok_or_else(|| RtError::new(codes::DATE_MATH, Kind::Runtime, "Date is out of range.", span))?
                } else {
                    date_add_months(d, n, span)?
                };
                Ok(Value::Date(r))
            }
            _ => {
                self.none(&what, args, span)?;
                Ok(match name {
                    "year" => Value::Int(d.year() as i64),
                    "month" => Value::Int(d.month() as i64),
                    "day" => Value::Int(d.day() as i64),
                    "dayOfWeek" => Value::Int(d.weekday().number_from_monday() as i64),
                    "startOfMonth" => Value::Date(d.with_day(1).expect("day 1 exists")),
                    "endOfMonth" => {
                        let next = date_add_months(d.with_day(1).expect("day 1 exists"), 1, span)?;
                        Value::Date(next.pred_opt().expect("previous day exists"))
                    }
                    _ => return Err(Self::no_method(&Value::Date(d), name, span)),
                })
            }
        }
    }

    fn array_method(&mut self, recv: &Value, a: Rc<RefCell<Vec<Value>>>, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let what = format!("Array.{name}()");
        let index = |v: &Option<Value>| want_int(&what, v.as_ref().unwrap_or(&Value::Null), span);
        let range_err = |i: i64, len: usize| RtError::new(codes::INDEX_RANGE, Kind::Runtime, format!("Index {i} is out of range (length {len})."), span);
        match name {
            "count" | "isEmpty" | "first" | "last" | "reverse" | "sort" | "sum" => {
                self.none(&what, args, span)?;
                match name {
                    "count" => Ok(Value::Int(a.borrow().len() as i64)),
                    "isEmpty" => Ok(Value::Bool(a.borrow().is_empty())),
                    "first" => Ok(a.borrow().first().cloned().unwrap_or(Value::Null)),
                    "last" => Ok(a.borrow().last().cloned().unwrap_or(Value::Null)),
                    "reverse" => {
                        a.borrow_mut().reverse();
                        Ok(Value::Null)
                    }
                    "sort" => {
                        let mut items = a.borrow().clone();
                        let mut failure = None;
                        items.sort_by(|x, y| match compare(x, y, span) {
                            Ok(o) => o,
                            Err(e) => {
                                failure.get_or_insert(e);
                                Ordering::Equal
                            }
                        });
                        if let Some(e) = failure {
                            return Err(e);
                        }
                        *a.borrow_mut() = items;
                        Ok(Value::Null)
                    }
                    _ => {
                        let mut total = Value::Int(0);
                        for v in a.borrow().iter() {
                            total = if matches!(total, Value::Int(0)) && matches!(v, Value::Money(..)) { v.clone() } else { arith(BinaryOp::Add, &total, v, span)? };
                        }
                        Ok(total)
                    }
                }
            }
            "add" => {
                let p = self.params(&what, &["value"], 1, args, span)?;
                let len = a.borrow().len();
                self.check_len(len + 1, span)?;
                self.charge(32, span)?;
                a.borrow_mut().push(p.into_iter().next().flatten().unwrap_or(Value::Null));
                Ok(Value::Null)
            }
            "insert" => {
                let p = self.params(&what, &["index", "value"], 2, args, span)?;
                let i = index(&p[0])?;
                let len = a.borrow().len();
                if i < 0 || i as usize > len {
                    return Err(range_err(i, len));
                }
                self.check_len(len + 1, span)?;
                self.charge(32, span)?;
                a.borrow_mut().insert(i as usize, p[1].clone().unwrap_or(Value::Null));
                Ok(Value::Null)
            }
            "remove" => {
                let p = self.params(&what, &["index"], 1, args, span)?;
                let i = index(&p[0])?;
                let len = a.borrow().len();
                if i < 0 || i as usize >= len {
                    return Err(range_err(i, len));
                }
                Ok(a.borrow_mut().remove(i as usize))
            }
            "contains" | "indexOf" => {
                let p = self.params(&what, &["value"], 1, args, span)?;
                let needle = p[0].clone().unwrap_or(Value::Null);
                let pos = a.borrow().iter().position(|v| v.equals(&needle));
                Ok(if name == "contains" { Value::Bool(pos.is_some()) } else { Value::Int(pos.map(|p| p as i64).unwrap_or(-1)) })
            }
            "join" => {
                let p = self.params(&what, &["separator"], 0, args, span)?;
                let sep = match &p[0] {
                    None | Some(Value::Null) => Rc::from(""),
                    Some(v) => want_str(&what, v, span)?,
                };
                let parts: Vec<String> = a.borrow().iter().map(Value::display).collect();
                let out = parts.join(&sep);
                self.new_str(out, span)
            }
            "slice" => {
                let p = self.params(&what, &["start", "end"], 1, args, span)?;
                let len = a.borrow().len();
                let start = index(&p[0])?;
                let end = match &p[1] {
                    None | Some(Value::Null) => len as i64,
                    Some(v) => want_int(&what, v, span)?,
                };
                if start < 0 || end < start || end as usize > len {
                    return Err(RtError::new(codes::INDEX_RANGE, Kind::Runtime, format!("slice({start}, {end}) is outside an array of length {len}."), span));
                }
                let items = a.borrow()[start as usize..end as usize].to_vec();
                self.new_array(items, span)
            }
            _ => Err(Self::no_method(recv, name, span)),
        }
    }

    fn map_method(&mut self, m: Rc<RefCell<crate::value::OrderedMap>>, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let what = format!("Map.{name}()");
        let key = |v: &Option<Value>| want_str(&what, v.as_ref().unwrap_or(&Value::Null), span);
        match name {
            "count" => {
                self.none(&what, args, span)?;
                Ok(Value::Int(m.borrow().len() as i64))
            }
            "isEmpty" => {
                self.none(&what, args, span)?;
                Ok(Value::Bool(m.borrow().is_empty()))
            }
            "has" => {
                let p = self.params(&what, &["key"], 1, args, span)?;
                Ok(Value::Bool(m.borrow().contains(&key(&p[0])?)))
            }
            "get" => {
                let p = self.params(&what, &["key", "default"], 1, args, span)?;
                let k = key(&p[0])?;
                Ok(m.borrow().get(&k).cloned().or_else(|| p[1].clone()).unwrap_or(Value::Null))
            }
            "set" => {
                let p = self.params(&what, &["key", "value"], 2, args, span)?;
                let k = key(&p[0])?;
                let mut map = m.borrow_mut();
                if map.insert(k.clone(), p[1].clone().unwrap_or(Value::Null)) {
                    self.check_len(map.len(), span)?;
                    self.charge(48 + k.len(), span)?;
                }
                Ok(Value::Null)
            }
            "remove" => {
                let p = self.params(&what, &["key"], 1, args, span)?;
                let k = key(&p[0])?;
                Ok(m.borrow_mut().remove(&k).unwrap_or(Value::Null))
            }
            "keys" | "values" => {
                self.none(&what, args, span)?;
                let items: Vec<Value> = m.borrow().iter().map(|(k, v)| if name == "keys" { Value::Str(k.clone()) } else { v.clone() }).collect();
                self.new_array(items, span)
            }
            _ => Err(Self::no_method(&Value::Map(m), name, span)),
        }
    }

    // ----- business objects --------------------------------------------------------------

    fn guard_own(&self, o: &Obj, verb: &str, span: Span) -> RtResult<()> {
        match o.lock {
            Some(Lock { reason: LockReason::Handler(ev), .. }) => Err(RtError::new(
                codes::OBJECT_STATE,
                Kind::Runtime,
                format!("Cannot {verb} {} inside its own {} handler; the platform completes the operation after the handler.", o.type_name, ev.name()),
                span,
            )),
            Some(Lock { reason: LockReason::Reference, .. }) => {
                Err(RtError::new(codes::READ_ONLY, Kind::Runtime, format!("Data read through a reference to {} is read-only; call load() first.", o.type_name), span))
            }
            None => Ok(()),
        }
    }

    fn check_required(&self, o: &Obj, span: Span) -> RtResult<()> {
        let missing = |owner: String, field: &str| RtError::new(codes::REQUIRED, Kind::Runtime, format!("{owner}: \"{field}\" is required."), span);
        if let Some(fields) = self.meta.object_fields(&o.type_name) {
            for (f, v) in fields.iter().zip(&o.fields) {
                if f.required && matches!(v, Value::Null) {
                    return Err(missing(o.type_name.to_string(), &f.name));
                }
            }
        }
        if let Some(doc) = self.meta.document(&o.type_name) {
            for (rm, table) in doc.rows.iter().zip(&o.rows) {
                for row in table {
                    let row = row.borrow();
                    for (f, v) in rm.fields.iter().zip(&row.fields) {
                        if f.required && matches!(v, Value::Null) {
                            return Err(missing(format!("{} {} line {}", o.type_name, rm.name, row.line_no), &f.name));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn refresh(&mut self, o: &Rc<RefCell<Obj>>, w: &WireValue, span: Span) -> RtResult<()> {
        let WireValue::Object(wo) = w else {
            return Err(RtError::new(codes::HOST, Kind::Host, "The platform did not return the saved object.", span));
        };
        crate::convert::refresh_obj(o, wo, self.meta).map_err(|m| RtError::new(codes::HOST, Kind::Host, format!("The platform returned invalid data: {m}."), span))?;
        let (t, id) = {
            let b = o.borrow();
            (b.type_name.clone(), b.id.clone())
        };
        if let Some(id) = id {
            self.forget(&t, &id);
        }
        Ok(())
    }

    fn save_obj(&mut self, o: &Rc<RefCell<Obj>>, span: Span) -> RtResult<()> {
        let w = {
            let b = o.borrow();
            self.guard_own(&b, "save", span)?;
            self.check_required(&b, span)?;
            self.obj_to_wire(&b)
        };
        let r = self.host_call(HostCall::Save { object: w }, span)?;
        self.refresh(o, &r, span)
    }

    fn saved_id(o: &Obj, verb: &str, span: Span) -> RtResult<Rc<str>> {
        o.id.clone().ok_or_else(|| RtError::new(codes::NOT_SAVED, Kind::Runtime, format!("Save the new {} before you {verb} it.", o.type_name), span))
    }

    fn object_method(&mut self, o: Rc<RefCell<Obj>>, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let (kind, type_name) = {
            let b = o.borrow();
            (b.kind, b.type_name.clone())
        };
        let is_doc = kind == ObjectKind::Document;
        match name {
            "isNew" => {
                self.none("isNew()", args, span)?;
                Ok(Value::Bool(o.borrow().id.is_none()))
            }
            "ref" => {
                self.none("ref()", args, span)?;
                let id = Self::saved_id(&o.borrow(), "refer to", span)?;
                Ok(Value::Ref(Rc::new(RefVal { kind, type_name, id })))
            }
            "save" => {
                self.none("save()", args, span)?;
                self.save_obj(&o, span)?;
                Ok(Value::Null)
            }
            "delete" => {
                self.none("delete()", args, span)?;
                let id = {
                    let b = o.borrow();
                    self.guard_own(&b, "delete", span)?;
                    Self::saved_id(&b, "delete", span)?
                };
                self.host_call(HostCall::Delete { kind, type_name: type_name.to_string(), id: id.to_string() }, span)?;
                o.borrow_mut().deleted = true;
                self.forget(&type_name, &id);
                Ok(Value::Null)
            }
            "post" if is_doc => {
                self.none("post()", args, span)?;
                if o.borrow().status == Some(Status::Posted) {
                    return Err(RtError::new(codes::OBJECT_STATE, Kind::Runtime, format!("{} is already posted.", Value::Object(o.clone()).display()), span));
                }
                self.save_obj(&o, span)?;
                let id = Self::saved_id(&o.borrow(), "post", span)?;
                let r = self.host_call(HostCall::Post { type_name: type_name.to_string(), id: id.to_string() }, span)?;
                self.refresh(&o, &r, span)?;
                Ok(Value::Null)
            }
            "reverse" if is_doc => {
                self.none("reverse()", args, span)?;
                let id = {
                    let b = o.borrow();
                    self.guard_own(&b, "reverse", span)?;
                    Self::saved_id(&b, "reverse", span)?
                };
                let r = self.host_call(HostCall::Reverse { type_name: type_name.to_string(), id: id.to_string() }, span)?;
                self.refresh(&o, &r, span)?;
                Ok(Value::Null)
            }
            _ => Err(Self::no_method(&Value::Object(o), name, span)),
        }
    }

    fn rows_method(&mut self, o: Rc<RefCell<Obj>>, ri: usize, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let type_name = o.borrow().type_name.clone();
        let meta = self.meta;
        let rows_meta = &meta.document(&type_name).expect("rows of known document").rows[ri];
        let what = format!("{}.{}.{name}()", type_name, rows_meta.name);
        match name {
            "count" => {
                self.none(&what, args, span)?;
                Ok(Value::Int(o.borrow().rows[ri].len() as i64))
            }
            "isEmpty" => {
                self.none(&what, args, span)?;
                Ok(Value::Bool(o.borrow().rows[ri].is_empty()))
            }
            "first" | "last" => {
                self.none(&what, args, span)?;
                let b = o.borrow();
                let r = if name == "first" { b.rows[ri].first() } else { b.rows[ri].last() };
                Ok(r.map(|r| Value::Row(r.clone())).unwrap_or(Value::Null))
            }
            "get" => {
                let p = self.params(&what, &["index"], 1, args, span)?;
                self.get_index(&Value::Rows(o.clone(), ri), p[0].as_ref().unwrap_or(&Value::Null), span)
            }
            "add" => {
                if args.iter().any(|a| a.name.is_none()) {
                    return Err(RtError::new(codes::ARGS, Kind::Type, format!("{what} takes named fields, as in add(product: p, quantity: 2)."), span));
                }
                let row = self.new_row(&o, ri, span)?;
                for a in args {
                    let n = a.name.expect("named");
                    let Some(i) = rows_meta.fields.iter().position(|f| *f.name == *n) else {
                        o.borrow_mut().rows[ri].pop();
                        return Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("Rows {}.{} have no field \"{n}\".", type_name, rows_meta.name), span));
                    };
                    match coerce_field(&rows_meta.fields[i], a.value) {
                        Ok(v) => row.borrow_mut().fields[i] = v,
                        Err((c, m)) => {
                            o.borrow_mut().rows[ri].pop();
                            return Err(RtError::new(c, Kind::Type, m, span));
                        }
                    }
                }
                Ok(Value::Row(row))
            }
            "remove" | "clear" => {
                let lock = o.borrow().lock;
                self.check_writable(lock, &type_name, span)?;
                if name == "clear" {
                    self.none(&what, args, span)?;
                    o.borrow_mut().rows[ri].clear();
                    return Ok(Value::Null);
                }
                let p = self.params(&what, &["row"], 1, args, span)?;
                let len = o.borrow().rows[ri].len();
                let ix = match p[0].as_ref().unwrap_or(&Value::Null) {
                    Value::Int(i) if *i >= 0 && (*i as usize) < len => *i as usize,
                    Value::Int(i) => return Err(RtError::new(codes::INDEX_RANGE, Kind::Runtime, format!("Index {i} is out of range (length {len})."), span)),
                    Value::Row(r) => {
                        o.borrow().rows[ri].iter().position(|x| Rc::ptr_eq(x, r)).ok_or_else(|| RtError::new(codes::ARGS, Kind::Runtime, "That row does not belong to these rows.", span))?
                    }
                    v => return Err(arg_type(&what, "an index or a row", v, span)),
                };
                let mut b = o.borrow_mut();
                b.rows[ri].remove(ix);
                Interp::renumber(&b, ri);
                Ok(Value::Null)
            }
            "sum" => {
                let p = self.params(&what, &["field"], 1, args, span)?;
                let field = want_str(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                let Some(i) = rows_meta.fields.iter().position(|f| *f.name == *field) else {
                    return Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("Rows {}.{} have no field \"{field}\".", type_name, rows_meta.name), span));
                };
                let mut total = match rows_meta.fields[i].ty {
                    FieldType::Integer => Value::Int(0),
                    FieldType::Decimal { .. } => Value::Dec(Decimal::ZERO),
                    _ => return Err(RtError::new(codes::TYPE, Kind::Type, format!("sum() adds numeric fields; \"{field}\" is {}.", rows_meta.fields[i].ty.describe()), span)),
                };
                for r in o.borrow().rows[ri].iter() {
                    let v = r.borrow().fields[i].clone();
                    if !matches!(v, Value::Null) {
                        total = arith(BinaryOp::Add, &total, &v, span)?;
                    }
                }
                Ok(total)
            }
            _ => Err(Self::no_method(&Value::Rows(o, ri), name, span)),
        }
    }

    fn manager_method(&mut self, root: Root, type_name: Rc<str>, name: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let what = format!("{}.{}.{name}()", root.name(), type_name);
        if root == Root::Register {
            return match name {
                "increase" => self.movement(&type_name, Direction::In, args, span),
                "decrease" => self.movement(&type_name, Direction::Out, args, span),
                "balance" => self.balance(&type_name, args, span),
                _ => Err(Self::no_method(&Value::Service(Service::Manager(root, type_name)), name, span)),
            };
        }
        let meta = self.meta;
        let Some(kind) = meta.object_kind(&type_name) else {
            return Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("{} has no {type_name}.", root.name()), span));
        };
        let find_by = |interp: &mut Self, field: &str, value: Value| -> RtResult<Value> {
            let value = interp.to_wire(&value, span)?;
            let w = interp.host_call(HostCall::FindBy { kind, type_name: type_name.to_string(), field: field.to_string(), value }, span)?;
            Ok(interp.obj_from_wire_value(&w, span)?.map(Value::Object).unwrap_or(Value::Null))
        };
        match name {
            "create" => {
                if args.iter().any(|a| a.name.is_none()) {
                    return Err(RtError::new(codes::ARGS, Kind::Type, format!("{what} takes named fields, as in create(code: \"P-1\")."), span));
                }
                let obj = Rc::new(RefCell::new(new_obj(meta, &type_name).expect("known object")));
                self.charge(128 + obj.borrow().fields.len() * 32, span)?;
                for a in args {
                    self.set_field(&obj, &a.name.expect("named"), a.value, span)?;
                }
                Ok(Value::Object(obj))
            }
            "findById" => {
                let p = self.params(&what, &["id"], 1, args, span)?;
                let id = want_str(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                let w = self.host_call(HostCall::FindById { kind, type_name: type_name.to_string(), id: id.to_string() }, span)?;
                Ok(self.obj_from_wire_value(&w, span)?.map(Value::Object).unwrap_or(Value::Null))
            }
            "findByCode" if kind == ObjectKind::Catalog => {
                let p = self.params(&what, &["code"], 1, args, span)?;
                find_by(self, "code", p[0].clone().unwrap_or(Value::Null))
            }
            "findByNumber" if kind == ObjectKind::Document => {
                let p = self.params(&what, &["number"], 1, args, span)?;
                let n = want_str(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                find_by(self, "number", Value::Str(n))
            }
            "findBy" => {
                let p = self.params(&what, &["field", "value"], 2, args, span)?;
                let field = want_str(&what, p[0].as_ref().unwrap_or(&Value::Null), span)?;
                let f = meta.object_fields(&type_name).and_then(|fs| fs.iter().find(|f| *f.name == *field));
                let Some(f) = f else {
                    return Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("{type_name} has no field \"{field}\"."), span));
                };
                let v = coerce_field(f, p[1].clone().unwrap_or(Value::Null)).map_err(|(c, m)| RtError::new(c, Kind::Type, m, span))?;
                find_by(self, &field, v)
            }
            "list" => {
                let mut filter = BTreeMap::new();
                let (mut limit, mut offset) = (100u32, 0u32);
                for a in args {
                    let Some(n) = a.name else {
                        return Err(RtError::new(codes::ARGS, Kind::Type, format!("{what} takes named filters, as in list(active: true, limit: 50)."), span));
                    };
                    match &*n {
                        "limit" => {
                            limit = u32::try_from(want_int(&what, &a.value, span)?)
                                .ok()
                                .filter(|l| (1..=1000).contains(l))
                                .ok_or_else(|| RtError::new(codes::ARGS, Kind::Runtime, "limit is 1 to 1000.", span))?
                        }
                        "offset" => offset = u32::try_from(want_int(&what, &a.value, span)?).map_err(|_| RtError::new(codes::ARGS, Kind::Runtime, "offset cannot be negative.", span))?,
                        field => {
                            let Some(f) = meta.object_fields(&type_name).and_then(|fs| fs.iter().find(|f| f.name == field)) else {
                                return Err(RtError::new(codes::NO_MEMBER, Kind::Type, format!("{type_name} has no field \"{field}\"."), span));
                            };
                            let v = coerce_field(f, a.value).map_err(|(c, m)| RtError::new(c, Kind::Type, m, span))?;
                            filter.insert(field.to_string(), self.to_wire(&v, span)?);
                        }
                    }
                }
                let w = self.host_call(HostCall::List { kind, type_name: type_name.to_string(), filter, limit, offset }, span)?;
                let WireValue::Array(items) = &w else {
                    return Err(RtError::new(codes::HOST, Kind::Host, "The platform returned something other than a list.", span));
                };
                let mut out = Vec::with_capacity(items.len());
                for i in items {
                    match self.obj_from_wire_value(i, span)? {
                        Some(o) => out.push(Value::Object(o)),
                        None => return Err(RtError::new(codes::HOST, Kind::Host, "The platform returned an empty list entry.", span)),
                    }
                }
                self.new_array(out, span)
            }
            _ => Err(Self::no_method(&Value::Service(Service::Manager(root, type_name.clone())), name, span)),
        }
    }

    fn movement(&mut self, register: &str, direction: Direction, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let reg_err = |m: String| RtError::new(codes::REGISTER, Kind::Runtime, m, span);
        if !self.posting {
            return Err(reg_err(format!("Register movements can only be made while a document posts (in a Post handler); {register} was changed outside one.")));
        }
        let meta = self.meta;
        let Some(reg) = meta.register(register) else {
            return Err(reg_err(format!("This application has no register named \"{register}\".")));
        };
        if reg.ty != RegisterType::Accumulation {
            return Err(reg_err(format!("{register} is an information register; increase() and decrease() apply to accumulation registers.")));
        }
        let mut dimensions = BTreeMap::new();
        let mut measures = BTreeMap::new();
        for a in args {
            let Some(n) = a.name else {
                return Err(RtError::new(codes::ARGS, Kind::Type, format!("Arguments of {register} movements are named, as in product: item.product."), span));
            };
            let (field, target) = if let Some(d) = reg.dimensions.iter().find(|d| *d.name == *n) {
                (d, &mut dimensions)
            } else if let Some(m) = reg.values.iter().find(|m| *m.name == *n) {
                (m, &mut measures)
            } else {
                return Err(RtError::new(codes::ARGS, Kind::Type, format!("{register} has no dimension or measure \"{n}\"."), span));
            };
            let v = coerce_field(field, a.value).map_err(|(c, m)| RtError::new(c, Kind::Type, format!("{register}: {m}"), span))?;
            let w = self.to_wire(&v, span)?;
            target.insert(n.to_string(), w);
        }
        for d in &reg.dimensions {
            if matches!(dimensions.get(&d.name), None | Some(WireValue::Null)) {
                return Err(reg_err(format!("{register} needs a value for the dimension \"{}\".", d.name)));
            }
        }
        for m in &reg.values {
            match measures.get(&m.name) {
                Some(WireValue::Null) | None => {
                    let zero = match m.ty {
                        FieldType::Decimal { scale, .. } => {
                            let mut z = Decimal::ZERO;
                            z.rescale(scale);
                            WireValue::Dec(z.to_string())
                        }
                        _ => WireValue::Int(0),
                    };
                    measures.insert(m.name.clone(), zero);
                }
                _ => {}
            }
        }
        self.check_len(self.intents.len() + 1, span)?;
        self.charge(256, span)?;
        self.intents.push(Intent::RegisterMovement { register: register.to_string(), direction, dimensions, measures });
        Ok(Value::Null)
    }

    fn balance(&mut self, register: &str, args: Vec<Arg>, span: Span) -> RtResult<Value> {
        let meta = self.meta;
        let Some(reg) = meta.register(register) else {
            return Err(RtError::new(codes::REGISTER, Kind::Runtime, format!("This application has no register named \"{register}\"."), span));
        };
        let mut dimensions = BTreeMap::new();
        let mut at = None;
        for a in args {
            let Some(n) = a.name else {
                return Err(RtError::new(codes::ARGS, Kind::Type, format!("Arguments of {register}.balance() are named, as in product: p."), span));
            };
            if &*n == "at" {
                at = match a.value {
                    Value::Date(d) => Some(d.format("%Y-%m-%d").to_string()),
                    Value::DateTime(d) => Some(crate::convert::format_datetime(&d)),
                    Value::Null => None,
                    v => return Err(arg_type("balance(at:)", "a Date or DateTime", &v, span)),
                };
                continue;
            }
            let Some(d) = reg.dimensions.iter().find(|d| *d.name == *n) else {
                return Err(RtError::new(codes::ARGS, Kind::Type, format!("{register} has no dimension \"{n}\"."), span));
            };
            let v = coerce_field(d, a.value).map_err(|(c, m)| RtError::new(c, Kind::Type, m, span))?;
            dimensions.insert(n.to_string(), self.to_wire(&v, span)?);
        }
        let w = self.host_call(HostCall::RegisterBalance { register: register.to_string(), dimensions, at }, span)?;
        self.decode_wire(&w, span)
    }
}
