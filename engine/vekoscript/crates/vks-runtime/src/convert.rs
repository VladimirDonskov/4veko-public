//! Conversions between runtime values, protocol values and metadata-typed fields.

use crate::error::codes;
use crate::value::{Lock, Obj, OrderedMap, RefVal, RowData, Status, Value};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use rust_decimal::Decimal;
use std::cell::RefCell;
use std::rc::Rc;
use std::str::FromStr;
use vks_metadata::{DefaultValue, FieldMeta, FieldType, MetadataModel, ObjectKind};
use vks_protocol::{WireObject, WireRow, WireValue};

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// RFC 3339 with any offset, normalized to UTC and whole seconds.
pub fn parse_datetime(s: &str) -> Option<NaiveDateTime> {
    use chrono::Timelike;
    DateTime::parse_from_rfc3339(s).ok()?.naive_utc().with_nanosecond(0)
}

pub fn format_datetime(d: &NaiveDateTime) -> String {
    d.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// An ISO 4217-style currency code: three uppercase letters.
pub fn valid_currency(c: &str) -> bool {
    c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())
}

pub fn wire_to_value(w: &WireValue, meta: &MetadataModel) -> Result<Value, String> {
    Ok(match w {
        WireValue::Null => Value::Null,
        WireValue::Bool(b) => Value::Bool(*b),
        WireValue::Int(i) => Value::Int(*i),
        WireValue::Dec(s) => Value::Dec(Decimal::from_str(s).map_err(|_| format!("\"{s}\" is not a decimal"))?),
        WireValue::Str(s) => Value::Str(Rc::from(s.as_str())),
        WireValue::Date(s) => Value::Date(parse_date(s).ok_or_else(|| format!("\"{s}\" is not a date (YYYY-MM-DD)"))?),
        WireValue::DateTime(s) => Value::DateTime(parse_datetime(s).ok_or_else(|| format!("\"{s}\" is not an RFC 3339 date-time"))?),
        WireValue::Duration(s) => Value::Duration(*s),
        WireValue::Money { amount, currency } => {
            if !valid_currency(currency) {
                return Err(format!("\"{currency}\" is not a currency code"));
            }
            Value::Money(Decimal::from_str(amount).map_err(|_| format!("\"{amount}\" is not an amount"))?, Rc::from(currency.as_str()))
        }
        WireValue::Array(items) => Value::array(items.iter().map(|i| wire_to_value(i, meta)).collect::<Result<_, _>>()?),
        WireValue::Map(entries) => {
            let mut m = OrderedMap::new();
            for (k, v) in entries {
                m.insert(Rc::from(k.as_str()), wire_to_value(v, meta)?);
            }
            Value::map(m)
        }
        WireValue::Ref { kind, type_name, id } => {
            if meta.object_kind(type_name) != Some(*kind) {
                return Err(format!("reference to unknown {type_name}"));
            }
            Value::Ref(Rc::new(RefVal { kind: *kind, type_name: Rc::from(type_name.as_str()), id: Rc::from(id.as_str()) }))
        }
        WireValue::Object(o) => Value::Object(obj_from_wire(o, meta)?),
    })
}

pub fn value_to_wire(v: &Value, meta: &MetadataModel) -> Result<WireValue, String> {
    Ok(match v {
        Value::Null => WireValue::Null,
        Value::Bool(b) => WireValue::Bool(*b),
        Value::Int(i) => WireValue::Int(*i),
        Value::Dec(d) => WireValue::Dec(d.to_string()),
        Value::Str(s) => WireValue::Str(s.to_string()),
        Value::Date(d) => WireValue::Date(d.format("%Y-%m-%d").to_string()),
        Value::DateTime(d) => WireValue::DateTime(format_datetime(d)),
        Value::Duration(s) => WireValue::Duration(*s),
        Value::Money(a, c) => WireValue::Money { amount: a.to_string(), currency: c.to_string() },
        Value::Array(a) => WireValue::Array(a.borrow().iter().map(|x| value_to_wire(x, meta)).collect::<Result<_, _>>()?),
        Value::Map(m) => WireValue::Map(m.borrow().iter().map(|(k, x)| Ok((k.to_string(), value_to_wire(x, meta)?))).collect::<Result<_, String>>()?),
        Value::Ref(r) => WireValue::Ref { kind: r.kind, type_name: r.type_name.to_string(), id: r.id.to_string() },
        Value::Object(o) => WireValue::Object(Box::new(obj_to_wire(&o.borrow(), meta))),
        Value::Rows(..) | Value::Row(_) | Value::Func(_) | Value::Service(_) => return Err(format!("a {} cannot leave the script", v.kind_name())),
    })
}

pub fn default_value(f: &FieldMeta) -> Value {
    match &f.default {
        None | Some(DefaultValue::Null) => Value::Null,
        Some(DefaultValue::Integer(i)) => Value::Int(*i),
        Some(DefaultValue::Decimal(s)) => Decimal::from_str(s).map(Value::Dec).unwrap_or(Value::Null),
        Some(DefaultValue::Boolean(b)) => Value::Bool(*b),
        Some(DefaultValue::String(s)) => match f.ty {
            FieldType::Date => parse_date(s).map(Value::Date).unwrap_or(Value::Null),
            _ => Value::Str(Rc::from(s.as_str())),
        },
    }
}

/// Exact fit of a number into Decimal(p, s), scaled to s places. Never rounds.
pub fn fit_decimal(d: Decimal, precision: u32, scale: u32) -> Result<Decimal, String> {
    let n = d.normalize();
    if n.scale() > scale {
        return Err(format!("{d} has more than {scale} decimal place(s); round it first, e.g. round(x, {scale})"));
    }
    let int_digits = n.trunc().abs().to_string().trim_start_matches('0').len() as u32;
    if int_digits > precision - scale {
        return Err(format!("{d} has more than {} digit(s) before the decimal point", precision - scale));
    }
    let mut out = d;
    out.rescale(scale);
    Ok(out)
}

/// Check a value against a field's declared type. Business objects become references.
/// Errors carry a runtime error code and message.
pub fn coerce_field(f: &FieldMeta, v: Value) -> Result<Value, (&'static str, String)> {
    let bad = |what: &str| (codes::FIELD_TYPE, format!("Field \"{}\" is {}; {what}.", f.name, f.ty.describe()));
    match (&f.ty, v) {
        (_, Value::Null) => Ok(Value::Null),
        (FieldType::String { max_length }, Value::Str(s)) => {
            if let Some(m) = max_length {
                let n = s.chars().count();
                if n > *m as usize {
                    return Err(bad(&format!("the text has {n} characters")));
                }
            }
            Ok(Value::Str(s))
        }
        (FieldType::Decimal { precision, scale }, v @ (Value::Int(_) | Value::Dec(_))) => {
            let d = match v {
                Value::Int(i) => Decimal::from(i),
                Value::Dec(d) => d,
                _ => unreachable!(),
            };
            fit_decimal(d, *precision, *scale).map(Value::Dec).map_err(|m| (codes::FIELD_TYPE, format!("Field \"{}\" is {}: {m}.", f.name, f.ty.describe())))
        }
        (FieldType::Integer, v @ Value::Int(_)) => Ok(v),
        (FieldType::Boolean, v @ Value::Bool(_)) => Ok(v),
        (FieldType::Date, v @ Value::Date(_)) => Ok(v),
        (FieldType::DateTime, v @ Value::DateTime(_)) => Ok(v),
        (FieldType::Ref { target, .. }, Value::Ref(r)) => {
            if *r.type_name == **target {
                Ok(Value::Ref(r))
            } else {
                Err(bad(&format!("got a reference to {}", r.type_name)))
            }
        }
        (FieldType::Ref { target, target_kind }, Value::Object(o)) => {
            let o = o.borrow();
            if *o.type_name != **target {
                return Err(bad(&format!("got {}", o.type_name)));
            }
            match &o.id {
                Some(id) => Ok(Value::Ref(Rc::new(RefVal { kind: *target_kind, type_name: o.type_name.clone(), id: id.clone() }))),
                None => Err((codes::NOT_SAVED, format!("Save the new {} before referring to it from \"{}\".", o.type_name, f.name))),
            }
        }
        (_, v) => Err(bad(&format!("got {}", v.kind_name()))),
    }
}

pub fn new_obj(meta: &MetadataModel, type_name: &str) -> Option<Obj> {
    let kind = meta.object_kind(type_name)?;
    let fields = meta.object_fields(type_name)?.iter().map(default_value).collect();
    let rows = meta.document(type_name).map(|d| vec![Vec::new(); d.rows.len()]).unwrap_or_default();
    Some(Obj {
        kind,
        type_name: Rc::from(type_name),
        id: None,
        version: None,
        number: None,
        date: None,
        status: if kind == ObjectKind::Document { Some(Status::Draft) } else { None },
        deleted: false,
        fields,
        rows,
        lock: None,
    })
}

pub fn new_row(meta: &MetadataModel, doc: &Rc<RefCell<Obj>>, rows_index: usize) -> RowData {
    let type_name = doc.borrow().type_name.clone();
    let fields = meta.document(&type_name).map(|d| d.rows[rows_index].fields.iter().map(default_value).collect()).unwrap_or_default();
    RowData { doc_type: type_name, rows_index, line_no: 0, fields, parent: Rc::downgrade(doc) }
}

fn field_from_wire(f: &FieldMeta, w: Option<&WireValue>, meta: &MetadataModel) -> Result<Value, String> {
    let v = match w {
        None => return Ok(Value::Null),
        Some(w) => wire_to_value(w, meta)?,
    };
    coerce_field(f, v).map_err(|(_, m)| m)
}

/// Build a script object from platform data, checking every field against metadata.
pub fn obj_from_wire(w: &WireObject, meta: &MetadataModel) -> Result<Rc<RefCell<Obj>>, String> {
    let Some(fields_meta) = meta.object_fields(&w.type_name) else {
        return Err(format!("unknown object type {}", w.type_name));
    };
    if meta.object_kind(&w.type_name) != Some(w.kind) {
        return Err(format!("{} is not a {:?}", w.type_name, w.kind));
    }
    for k in w.fields.keys() {
        if !fields_meta.iter().any(|f| &f.name == k) {
            return Err(format!("{} has no field \"{k}\"", w.type_name));
        }
    }
    let fields = fields_meta.iter().map(|f| field_from_wire(f, w.fields.get(&f.name), meta)).collect::<Result<Vec<_>, _>>()?;
    let date = match &w.date {
        Some(d) => Some(parse_date(d).ok_or_else(|| format!("\"{d}\" is not a date"))?),
        None => None,
    };
    let status = match &w.status {
        Some(s) => Some(Status::parse(s).ok_or_else(|| format!("unknown status \"{s}\""))?),
        None if w.kind == ObjectKind::Document => Some(Status::Draft),
        None => None,
    };
    let obj = Rc::new(RefCell::new(Obj {
        kind: w.kind,
        type_name: Rc::from(w.type_name.as_str()),
        id: w.id.as_deref().map(Rc::from),
        version: w.version,
        number: w.number.as_deref().map(Rc::from),
        date,
        status,
        deleted: w.deleted,
        fields,
        rows: Vec::new(),
        lock: None,
    }));
    if let Some(doc) = meta.document(&w.type_name) {
        for k in w.rows.keys() {
            if !doc.rows.iter().any(|r| &r.name == k) {
                return Err(format!("{} has no rows \"{k}\"", w.type_name));
            }
        }
        let mut tables = Vec::with_capacity(doc.rows.len());
        for (ri, rm) in doc.rows.iter().enumerate() {
            let mut table = Vec::new();
            for (i, wr) in w.rows.get(&rm.name).map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
                for k in wr.fields.keys() {
                    if !rm.fields.iter().any(|f| &f.name == k) {
                        return Err(format!("rows {}.{} have no field \"{k}\"", w.type_name, rm.name));
                    }
                }
                let fields = rm.fields.iter().map(|f| field_from_wire(f, wr.fields.get(&f.name), meta)).collect::<Result<Vec<_>, _>>()?;
                table.push(Rc::new(RefCell::new(RowData { doc_type: Rc::from(w.type_name.as_str()), rows_index: ri, line_no: i as u32 + 1, fields, parent: Rc::downgrade(&obj) })));
            }
            tables.push(table);
        }
        obj.borrow_mut().rows = tables;
    }
    Ok(obj)
}

pub fn obj_to_wire(o: &Obj, meta: &MetadataModel) -> WireObject {
    let fields_meta = meta.object_fields(&o.type_name).unwrap_or(&[]);
    let fields = fields_meta.iter().zip(&o.fields).map(|(f, v)| (f.name.clone(), value_to_wire(v, meta).unwrap_or(WireValue::Null))).collect();
    let mut rows = std::collections::BTreeMap::new();
    if let Some(doc) = meta.document(&o.type_name) {
        for (rm, table) in doc.rows.iter().zip(&o.rows) {
            let wrows = table
                .iter()
                .map(|r| {
                    let r = r.borrow();
                    WireRow { line_no: Some(r.line_no), fields: rm.fields.iter().zip(&r.fields).map(|(f, v)| (f.name.clone(), value_to_wire(v, meta).unwrap_or(WireValue::Null))).collect() }
                })
                .collect();
            rows.insert(rm.name.clone(), wrows);
        }
    }
    WireObject {
        kind: o.kind,
        type_name: o.type_name.to_string(),
        id: o.id.as_deref().map(str::to_string),
        version: o.version,
        number: o.number.as_deref().map(str::to_string),
        date: o.date.map(|d| d.format("%Y-%m-%d").to_string()),
        status: o.status.map(|s| s.name().to_string()),
        deleted: o.deleted,
        fields,
        rows,
    }
}

/// Replace an object's data with what the platform returned (after save, post or reverse),
/// keeping the same shared object so every variable that holds it sees the result.
pub fn refresh_obj(target: &Rc<RefCell<Obj>>, from: &WireObject, meta: &MetadataModel) -> Result<(), String> {
    let fresh = obj_from_wire(from, meta)?;
    let mut fresh = Rc::try_unwrap(fresh).map_err(|_| "object is shared".to_string())?.into_inner();
    for table in &mut fresh.rows {
        for row in table.iter() {
            row.borrow_mut().parent = Rc::downgrade(target);
        }
    }
    let mut t = target.borrow_mut();
    let lock: Option<Lock> = t.lock;
    *t = fresh;
    t.lock = lock;
    Ok(())
}
