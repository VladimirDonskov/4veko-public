//! Operators: arithmetic with exact decimals and checked integers, comparison and equality.

use crate::error::{codes, RtError, RtResult};
use crate::value::Value;
use chrono::{Duration as ChronoDuration, NaiveDate, NaiveDateTime};
use rust_decimal::Decimal;
use std::cmp::Ordering;
use std::rc::Rc;
use vks_syntax::ast::BinaryOp;
use vks_syntax::{Kind, Span};

fn type_err(msg: String, span: Span) -> RtError {
    RtError::new(codes::TYPE, Kind::Type, msg, span)
}

fn dec_overflow(span: Span) -> RtError {
    RtError::new(codes::DEC_OVERFLOW, Kind::Runtime, "Decimal result is out of range (28 significant digits).", span)
}

fn int_overflow(span: Span) -> RtError {
    RtError::new(codes::INT_OVERFLOW, Kind::Runtime, "Integer overflow: the result does not fit in 64 bits. Use decimal() for larger numbers.", span)
}

fn div_zero(span: Span) -> RtError {
    RtError::new(codes::DIV_ZERO, Kind::Runtime, "Division by zero.", span)
}

fn as_dec(v: &Value) -> Option<Decimal> {
    match v {
        Value::Int(i) => Some(Decimal::from(*i)),
        Value::Dec(d) => Some(*d),
        _ => None,
    }
}

fn verb(op: BinaryOp) -> &'static str {
    match op {
        BinaryOp::Add => "add",
        BinaryOp::Sub => "subtract",
        BinaryOp::Mul => "multiply",
        BinaryOp::Div => "divide",
        BinaryOp::Rem => "take the remainder of",
        _ => "combine",
    }
}

fn mismatch(op: BinaryOp, a: &Value, b: &Value, span: Span) -> RtError {
    let hint = if op == BinaryOp::Add && (matches!(a, Value::Str(_)) || matches!(b, Value::Str(_))) {
        " Convert with str(x) or use format(\"{0}\", x)."
    } else if matches!(a, Value::Null) || matches!(b, Value::Null) {
        " One side is null."
    } else {
        ""
    };
    type_err(format!("Cannot {} {} and {}.{hint}", verb(op), a.kind_name(), b.kind_name()), span)
}

fn currency_check(a: &Rc<str>, b: &Rc<str>, span: Span) -> RtResult<()> {
    if a != b {
        return Err(RtError::new(codes::CURRENCY, Kind::Type, format!("Cannot combine {a} and {b} amounts; convert one currency first."), span));
    }
    Ok(())
}

fn date_plus(d: NaiveDate, secs: i64, span: Span) -> RtResult<Value> {
    if secs % 86_400 != 0 {
        return Err(RtError::new(codes::DATE_MATH, Kind::Type, "Only whole days can be added to a Date; use dateTime() for times.", span));
    }
    d.checked_add_signed(ChronoDuration::days(secs / 86_400)).map(Value::Date).ok_or_else(|| RtError::new(codes::DATE_MATH, Kind::Runtime, "Date is out of range.", span))
}

fn datetime_plus(d: NaiveDateTime, secs: i64, span: Span) -> RtResult<Value> {
    ChronoDuration::try_seconds(secs).and_then(|x| d.checked_add_signed(x)).map(Value::DateTime).ok_or_else(|| RtError::new(codes::DATE_MATH, Kind::Runtime, "DateTime is out of range.", span))
}

/// Arithmetic operators. `Concat` length limits are enforced by the caller.
pub fn arith(op: BinaryOp, a: &Value, b: &Value, span: Span) -> RtResult<Value> {
    use Value::*;
    match (op, a, b) {
        (BinaryOp::Add, Int(x), Int(y)) => x.checked_add(*y).map(Int).ok_or_else(|| int_overflow(span)),
        (BinaryOp::Sub, Int(x), Int(y)) => x.checked_sub(*y).map(Int).ok_or_else(|| int_overflow(span)),
        (BinaryOp::Mul, Int(x), Int(y)) => x.checked_mul(*y).map(Int).ok_or_else(|| int_overflow(span)),
        (BinaryOp::Rem, Int(x), Int(y)) => {
            if *y == 0 {
                return Err(div_zero(span));
            }
            x.checked_rem(*y).map(Int).ok_or_else(|| int_overflow(span))
        }
        (BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem, Int(_) | Dec(_), Int(_) | Dec(_)) => {
            let (x, y) = (as_dec(a).unwrap(), as_dec(b).unwrap());
            let r = match op {
                BinaryOp::Add => x.checked_add(y),
                BinaryOp::Sub => x.checked_sub(y),
                BinaryOp::Mul => x.checked_mul(y),
                BinaryOp::Div | BinaryOp::Rem if y.is_zero() => return Err(div_zero(span)),
                // Quotients carry no meaningful scale; show them without trailing zeros.
                BinaryOp::Div => x.checked_div(y).map(|q| q.normalize()),
                _ => x.checked_rem(y),
            };
            r.map(Dec).ok_or_else(|| dec_overflow(span))
        }
        (BinaryOp::Add, Str(x), Str(y)) => {
            let mut s = String::with_capacity(x.len() + y.len());
            s.push_str(x);
            s.push_str(y);
            Ok(Str(Rc::from(s)))
        }
        (BinaryOp::Add | BinaryOp::Sub, Money(x, c), Money(y, d)) => {
            currency_check(c, d, span)?;
            let r = if op == BinaryOp::Add { x.checked_add(*y) } else { x.checked_sub(*y) };
            r.map(|r| Money(r, c.clone())).ok_or_else(|| dec_overflow(span))
        }
        (BinaryOp::Mul, Money(x, c), Int(_) | Dec(_)) | (BinaryOp::Mul, Int(_) | Dec(_), Money(x, c)) => {
            let n = as_dec(if matches!(a, Money(..)) { b } else { a }).unwrap();
            x.checked_mul(n).map(|r| Money(r, c.clone())).ok_or_else(|| dec_overflow(span))
        }
        (BinaryOp::Div, Money(x, c), Int(_) | Dec(_)) => {
            let n = as_dec(b).unwrap();
            if n.is_zero() {
                return Err(div_zero(span));
            }
            x.checked_div(n).map(|r| Money(r, c.clone())).ok_or_else(|| dec_overflow(span))
        }
        (BinaryOp::Div, Money(x, c), Money(y, d)) => {
            currency_check(c, d, span)?;
            if y.is_zero() {
                return Err(div_zero(span));
            }
            x.checked_div(*y).map(Dec).ok_or_else(|| dec_overflow(span))
        }
        (BinaryOp::Add, Date(d), Duration(s)) | (BinaryOp::Add, Duration(s), Date(d)) => date_plus(*d, *s, span),
        (BinaryOp::Sub, Date(d), Duration(s)) => date_plus(*d, s.checked_neg().ok_or_else(|| int_overflow(span))?, span),
        (BinaryOp::Sub, Date(x), Date(y)) => Ok(Duration(x.signed_duration_since(*y).num_seconds())),
        (BinaryOp::Add, DateTime(d), Duration(s)) | (BinaryOp::Add, Duration(s), DateTime(d)) => datetime_plus(*d, *s, span),
        (BinaryOp::Sub, DateTime(d), Duration(s)) => datetime_plus(*d, s.checked_neg().ok_or_else(|| int_overflow(span))?, span),
        (BinaryOp::Sub, DateTime(x), DateTime(y)) => Ok(Duration(x.signed_duration_since(*y).num_seconds())),
        (BinaryOp::Add, Duration(x), Duration(y)) => x.checked_add(*y).map(Duration).ok_or_else(|| int_overflow(span)),
        (BinaryOp::Sub, Duration(x), Duration(y)) => x.checked_sub(*y).map(Duration).ok_or_else(|| int_overflow(span)),
        (BinaryOp::Mul, Duration(x), Int(n)) | (BinaryOp::Mul, Int(n), Duration(x)) => x.checked_mul(*n).map(Duration).ok_or_else(|| int_overflow(span)),
        _ => Err(mismatch(op, a, b, span)),
    }
}

/// Ordering for `< <= > >=`, sorting, min and max. Only like values compare.
pub fn compare(a: &Value, b: &Value, span: Span) -> RtResult<Ordering> {
    use Value::*;
    match (a, b) {
        (Int(x), Int(y)) => Ok(x.cmp(y)),
        (Int(_) | Dec(_), Int(_) | Dec(_)) => Ok(as_dec(a).unwrap().cmp(&as_dec(b).unwrap())),
        (Str(x), Str(y)) => Ok(x.cmp(y)),
        (Date(x), Date(y)) => Ok(x.cmp(y)),
        (DateTime(x), DateTime(y)) => Ok(x.cmp(y)),
        (Duration(x), Duration(y)) => Ok(x.cmp(y)),
        (Money(x, c), Money(y, d)) => {
            currency_check(c, d, span)?;
            Ok(x.cmp(y))
        }
        _ => Err(RtError::new(codes::COMPARE, Kind::Type, format!("Cannot compare {} with {}.", a.kind_name(), b.kind_name()), span)),
    }
}

pub fn binary(op: BinaryOp, a: &Value, b: &Value, span: Span) -> RtResult<Value> {
    match op {
        BinaryOp::Eq => Ok(Value::Bool(a.equals(b))),
        BinaryOp::NotEq => Ok(Value::Bool(!a.equals(b))),
        BinaryOp::Lt => Ok(Value::Bool(compare(a, b, span)? == Ordering::Less)),
        BinaryOp::LtEq => Ok(Value::Bool(compare(a, b, span)? != Ordering::Greater)),
        BinaryOp::Gt => Ok(Value::Bool(compare(a, b, span)? == Ordering::Greater)),
        BinaryOp::GtEq => Ok(Value::Bool(compare(a, b, span)? != Ordering::Less)),
        BinaryOp::And | BinaryOp::Or => unreachable!("short-circuit operators are lowered separately"),
        _ => arith(op, a, b, span),
    }
}

pub fn negate(v: &Value, span: Span) -> RtResult<Value> {
    match v {
        Value::Int(i) => i.checked_neg().map(Value::Int).ok_or_else(|| int_overflow(span)),
        Value::Dec(d) => Ok(Value::Dec(-*d)),
        Value::Money(d, c) => Ok(Value::Money(-*d, c.clone())),
        Value::Duration(s) => s.checked_neg().map(Value::Duration).ok_or_else(|| int_overflow(span)),
        _ => Err(type_err(format!("Cannot negate {}.", v.kind_name()), span)),
    }
}
