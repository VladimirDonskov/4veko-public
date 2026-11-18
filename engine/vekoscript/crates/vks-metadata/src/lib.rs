//! Business metadata: catalogs, documents and registers declared in VekoScript, validated into
//! an immutable model. The model is what the platform persists, generates storage from and
//! checks scripts against. Metadata never executes code.

mod migrate;
mod registry;

pub use migrate::{plan_migration, MigrationPlan, MigrationStep};
pub use registry::{MetadataRegistry, MetadataVersion};

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use vks_syntax::ast::{self, Item, Literal, Module, RegisterKind, TypeRef};
use vks_syntax::{Diagnostic, Kind, Span};

pub const MAX_STRING_LENGTH: u32 = 10_000;
pub const MAX_DECIMAL_PRECISION: u32 = 28;
pub const MAX_DIMENSIONS: usize = 16;
pub const MAX_FIELDS: usize = 200;

/// Names the platform owns; metadata objects cannot use them.
pub const RESERVED_OBJECT_NAMES: &[&str] = &["Catalog", "Document", "Register", "Accounting", "Context", "Query", "Workflow", "Platform"];
/// Fields every catalog record has.
pub const CATALOG_SYSTEM_FIELDS: &[&str] = &["id", "version", "deleted", "createdAt", "updatedAt"];
/// Fields every document has.
pub const DOCUMENT_SYSTEM_FIELDS: &[&str] = &["id", "version", "number", "date", "status", "deleted", "createdAt", "updatedAt"];
/// Fields every document row has.
pub const ROW_SYSTEM_FIELDS: &[&str] = &["lineNo"];
/// Fields every register movement has.
pub const REGISTER_SYSTEM_FIELDS: &[&str] = &["period", "recorder", "lineNo", "direction", "active"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    Catalog,
    Document,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FieldType {
    String { max_length: Option<u32> },
    Decimal { precision: u32, scale: u32 },
    Integer,
    Boolean,
    Date,
    DateTime,
    Ref { target: String, target_kind: ObjectKind },
}

impl FieldType {
    pub fn describe(&self) -> String {
        match self {
            FieldType::String { max_length: Some(n) } => format!("String({n})"),
            FieldType::String { max_length: None } => "String".into(),
            FieldType::Decimal { precision, scale } => format!("Decimal({precision}, {scale})"),
            FieldType::Integer => "Integer".into(),
            FieldType::Boolean => "Boolean".into(),
            FieldType::Date => "Date".into(),
            FieldType::DateTime => "DateTime".into(),
            FieldType::Ref { target, .. } => format!("Ref<{target}>"),
        }
    }
    pub fn is_numeric(&self) -> bool {
        matches!(self, FieldType::Decimal { .. } | FieldType::Integer)
    }
}

/// A default value in a JSON-friendly, exact form (decimals as strings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum DefaultValue {
    Integer(i64),
    Decimal(String),
    String(String),
    Boolean(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct FieldMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FieldType,
    pub required: bool,
    pub unique: bool,
    pub default: Option<DefaultValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMeta {
    pub name: String,
    pub fields: Vec<FieldMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct RowsMeta {
    pub name: String,
    pub fields: Vec<FieldMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeta {
    pub name: String,
    pub fields: Vec<FieldMeta>,
    pub rows: Vec<RowsMeta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegisterType {
    Accumulation,
    Information { periodic: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct RegisterMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: RegisterType,
    pub dimensions: Vec<FieldMeta>,
    /// Measures (accumulation) or resources (information).
    pub values: Vec<FieldMeta>,
}

/// The validated, immutable description of an application's business objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
#[serde(rename_all = "camelCase")]
pub struct MetadataModel {
    pub catalogs: Vec<CatalogMeta>,
    pub documents: Vec<DocumentMeta>,
    pub registers: Vec<RegisterMeta>,
}

impl MetadataModel {
    pub fn catalog(&self, name: &str) -> Option<&CatalogMeta> {
        self.catalogs.iter().find(|c| c.name == name)
    }
    pub fn document(&self, name: &str) -> Option<&DocumentMeta> {
        self.documents.iter().find(|d| d.name == name)
    }
    pub fn register(&self, name: &str) -> Option<&RegisterMeta> {
        self.registers.iter().find(|r| r.name == name)
    }
    pub fn object_kind(&self, name: &str) -> Option<ObjectKind> {
        if self.catalog(name).is_some() {
            Some(ObjectKind::Catalog)
        } else if self.document(name).is_some() {
            Some(ObjectKind::Document)
        } else {
            None
        }
    }
    /// Fields of a catalog or document (not rows).
    pub fn object_fields(&self, name: &str) -> Option<&[FieldMeta]> {
        self.catalog(name).map(|c| c.fields.as_slice()).or_else(|| self.document(name).map(|d| d.fields.as_slice()))
    }

    /// Objects each object refers to, for ordering storage creation and detecting cycles.
    pub fn dependencies(&self) -> BTreeMap<String, BTreeSet<String>> {
        let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let refs = |fields: &[FieldMeta]| -> Vec<String> {
            fields
                .iter()
                .filter_map(|f| match &f.ty {
                    FieldType::Ref { target, .. } => Some(target.clone()),
                    _ => None,
                })
                .collect()
        };
        for c in &self.catalogs {
            out.entry(c.name.clone()).or_default().extend(refs(&c.fields));
        }
        for d in &self.documents {
            let e = out.entry(d.name.clone()).or_default();
            e.extend(refs(&d.fields));
            for r in &d.rows {
                e.extend(refs(&r.fields));
            }
        }
        for r in &self.registers {
            let e = out.entry(r.name.clone()).or_default();
            e.extend(refs(&r.dimensions));
            e.extend(refs(&r.values));
        }
        out
    }

    /// Object names in an order where referenced objects come first when possible.
    /// Cycles (A refers to B and B to A) are allowed; their members keep declaration order.
    pub fn creation_order(&self) -> Vec<String> {
        let deps = self.dependencies();
        let mut done: Vec<String> = Vec::new();
        let mut visiting = BTreeSet::new();
        fn visit(n: &str, deps: &BTreeMap<String, BTreeSet<String>>, done: &mut Vec<String>, visiting: &mut BTreeSet<String>) {
            if done.iter().any(|d| d == n) || !visiting.insert(n.to_string()) {
                return;
            }
            if let Some(ds) = deps.get(n) {
                for d in ds {
                    visit(d, deps, done, visiting);
                }
            }
            done.push(n.to_string());
        }
        let names: Vec<String> = self.catalogs.iter().map(|c| c.name.clone()).chain(self.documents.iter().map(|d| d.name.clone())).chain(self.registers.iter().map(|r| r.name.clone())).collect();
        for n in &names {
            visit(n, &deps, &mut done, &mut visiting);
        }
        done
    }

    /// A stable fingerprint of the model (FNV-1a over its canonical JSON).
    pub fn fingerprint(&self) -> String {
        let json = serde_json::to_string(self).expect("metadata serializes");
        let mut h: u64 = 0xcbf29ce484222325;
        for b in json.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        format!("{h:016x}")
    }
}

/// Build and validate the metadata model from a parsed module.
pub fn build(module: &Module) -> (MetadataModel, Vec<Diagnostic>) {
    let mut diags = Vec::new();
    let mut err = |code: &'static str, msg: String, span: Span| diags.push(Diagnostic::error(code, Kind::Metadata, msg, span));

    // Pass 1: object names.
    let mut kinds: BTreeMap<String, (ObjectKind, Span)> = BTreeMap::new();
    let mut taken: BTreeMap<String, Span> = BTreeMap::new();
    for item in &module.items {
        let (name, span, kind) = match item {
            Item::Catalog(c) => (&c.name, c.span, Some(ObjectKind::Catalog)),
            Item::Document(d) => (&d.name, d.span, Some(ObjectKind::Document)),
            Item::Register(r) => (&r.name, r.span, None),
            _ => continue,
        };
        if RESERVED_OBJECT_NAMES.contains(&name.as_str()) {
            err("VKS2001", format!("\"{name}\" is reserved by the platform; choose another name."), span);
            continue;
        }
        if !name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
            err("VKS2002", format!("Object names start with a capital letter (\"{name}\")."), span);
        }
        if let Some(prev) = taken.get(name) {
            err("VKS2003", format!("\"{name}\" is already declared on line {}.", prev.line), span);
            continue;
        }
        taken.insert(name.clone(), span);
        if let Some(k) = kind {
            kinds.insert(name.clone(), (k, span));
        }
    }

    let mut model = MetadataModel::default();
    let convert_fields = |fields: &[ast::FieldDecl], reserved: &[&str], owner: &str, ctx: FieldContext, err: &mut dyn FnMut(&'static str, String, Span)| -> Vec<FieldMeta> {
        let mut out: Vec<FieldMeta> = Vec::new();
        if fields.len() > MAX_FIELDS {
            if let Some(f) = fields.get(MAX_FIELDS) {
                err("VKS2004", format!("{owner} has more than {MAX_FIELDS} fields."), f.span);
            }
        }
        for f in fields {
            if reserved.contains(&f.name.as_str()) {
                err("VKS2005", format!("\"{}\" is a system field of {owner} and cannot be declared.", f.name), f.span);
                continue;
            }
            if f.name.starts_with("__") || !f.name.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
                err("VKS2006", format!("Field names start with a lowercase letter (\"{}\").", f.name), f.span);
                continue;
            }
            if out.iter().any(|o| o.name == f.name) {
                err("VKS2007", format!("{owner} already has a field named \"{}\".", f.name), f.span);
                continue;
            }
            let Some(ty) = convert_type(&f.ty, f.ty_span, &kinds, err) else { continue };
            match ctx {
                FieldContext::Dimension if matches!(ty, FieldType::Decimal { .. } | FieldType::DateTime) => {
                    err("VKS2008", format!("Dimension \"{}\" must be a reference, String(n), Integer, Boolean or Date.", f.name), f.ty_span);
                }
                FieldContext::Dimension if matches!(ty, FieldType::String { max_length: None }) => {
                    err("VKS2008", format!("Dimension \"{}\" needs a maximum length, as in String(50).", f.name), f.ty_span);
                }
                FieldContext::Measure if !ty.is_numeric() => {
                    err("VKS2009", format!("Measure \"{}\" must be Decimal(p, s) or Integer.", f.name), f.ty_span);
                }
                _ => {}
            }
            if f.unique && !(ctx == FieldContext::Catalog && matches!(ty, FieldType::String { .. } | FieldType::Integer)) {
                err("VKS2010", format!("Only String and Integer fields of catalogs can be unique (\"{}\").", f.name), f.span);
            }
            if ctx != FieldContext::Plain && ctx != FieldContext::Catalog && (f.default.is_some() || f.required || f.unique) && ctx != FieldContext::Resource {
                err("VKS2011", format!("Register members cannot have required, unique or default (\"{}\"); dimensions are always required.", f.name), f.span);
            }
            let default = match &f.default {
                None => None,
                Some(lit) => match default_for(lit, &ty) {
                    Ok(d) => Some(d),
                    Err(msg) => {
                        err("VKS2012", format!("Default of \"{}\": {msg}", f.name), f.span);
                        None
                    }
                },
            };
            out.push(FieldMeta { name: f.name.clone(), ty, required: f.required || ctx == FieldContext::Dimension, unique: f.unique, default });
        }
        out
    };

    for item in &module.items {
        match item {
            Item::Catalog(c) if kinds.get(&c.name).is_some_and(|k| k.1 == c.span) => {
                let fields = convert_fields(&c.fields, CATALOG_SYSTEM_FIELDS, &format!("Catalog {}", c.name), FieldContext::Catalog, &mut err);
                if fields.is_empty() && c.fields.is_empty() {
                    err("VKS2013", format!("Catalog {} needs at least one field.", c.name), c.span);
                }
                model.catalogs.push(CatalogMeta { name: c.name.clone(), fields });
            }
            Item::Document(d) if kinds.get(&d.name).is_some_and(|k| k.1 == d.span) => {
                let fields = convert_fields(&d.fields, DOCUMENT_SYSTEM_FIELDS, &format!("Document {}", d.name), FieldContext::Plain, &mut err);
                let mut rows: Vec<RowsMeta> = Vec::new();
                for r in &d.rows {
                    if fields.iter().any(|f| f.name == r.name) || rows.iter().any(|x| x.name == r.name) || DOCUMENT_SYSTEM_FIELDS.contains(&r.name.as_str()) {
                        err("VKS2007", format!("Document {} already has a member named \"{}\".", d.name, r.name), r.span);
                        continue;
                    }
                    let rf = convert_fields(&r.fields, ROW_SYSTEM_FIELDS, &format!("Rows {}.{}", d.name, r.name), FieldContext::Plain, &mut err);
                    if r.fields.is_empty() {
                        err("VKS2013", format!("Rows {} need at least one field.", r.name), r.span);
                    }
                    rows.push(RowsMeta { name: r.name.clone(), fields: rf });
                }
                model.documents.push(DocumentMeta { name: d.name.clone(), fields, rows });
            }
            Item::Register(r) if taken.get(&r.name).is_some_and(|s| *s == r.span) => {
                let owner = format!("Register {}", r.name);
                let dimensions = convert_fields(&r.dimensions, REGISTER_SYSTEM_FIELDS, &owner, FieldContext::Dimension, &mut err);
                let values_ctx = if r.kind == RegisterKind::Accumulation { FieldContext::Measure } else { FieldContext::Resource };
                let values = convert_fields(&r.values, REGISTER_SYSTEM_FIELDS, &owner, values_ctx, &mut err);
                if r.dimensions.is_empty() {
                    err("VKS2014", format!("{owner} needs at least one dimension."), r.span);
                }
                if r.dimensions.len() > MAX_DIMENSIONS {
                    err("VKS2014", format!("{owner} has more than {MAX_DIMENSIONS} dimensions."), r.span);
                }
                if r.values.is_empty() {
                    let what = if r.kind == RegisterKind::Accumulation { "measure" } else { "resource" };
                    err("VKS2014", format!("{owner} needs at least one {what}."), r.span);
                }
                for v in &values {
                    if dimensions.iter().any(|d| d.name == v.name) {
                        err("VKS2007", format!("{owner} already has a member named \"{}\".", v.name), r.span);
                    }
                }
                let ty = match r.kind {
                    RegisterKind::Accumulation => RegisterType::Accumulation,
                    RegisterKind::Information { periodic } => RegisterType::Information { periodic },
                };
                model.registers.push(RegisterMeta { name: r.name.clone(), ty, dimensions, values });
            }
            _ => {}
        }
    }
    (model, diags)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldContext {
    Catalog,
    Plain,
    Dimension,
    Measure,
    Resource,
}

fn convert_type(t: &TypeRef, span: Span, kinds: &BTreeMap<String, (ObjectKind, Span)>, err: &mut dyn FnMut(&'static str, String, Span)) -> Option<FieldType> {
    Some(match t {
        TypeRef::String(len) => {
            if let Some(n) = len {
                if *n == 0 || *n > MAX_STRING_LENGTH {
                    err("VKS2015", format!("String length must be 1 to {MAX_STRING_LENGTH}."), span);
                    return None;
                }
            }
            FieldType::String { max_length: *len }
        }
        TypeRef::Decimal(p, s) => {
            if *p == 0 || *p > MAX_DECIMAL_PRECISION || s > p {
                err("VKS2016", format!("Decimal({p}, {s}) is not valid: precision 1 to {MAX_DECIMAL_PRECISION}, scale 0 to precision."), span);
                return None;
            }
            FieldType::Decimal { precision: *p, scale: *s }
        }
        TypeRef::Integer => FieldType::Integer,
        TypeRef::Boolean => FieldType::Boolean,
        TypeRef::Date => FieldType::Date,
        TypeRef::DateTime => FieldType::DateTime,
        TypeRef::Ref(target) => match kinds.get(target) {
            Some((k, _)) => FieldType::Ref { target: target.clone(), target_kind: *k },
            None => {
                err("VKS2017", format!("Ref<{target}> refers to an unknown catalog or document."), span);
                return None;
            }
        },
    })
}

/// Check that a declared default fits the field type exactly.
fn default_for(lit: &Literal, ty: &FieldType) -> Result<DefaultValue, String> {
    use rust_decimal::Decimal;
    match (lit, ty) {
        (Literal::Null, _) => Ok(DefaultValue::Null),
        (Literal::Bool(b), FieldType::Boolean) => Ok(DefaultValue::Boolean(*b)),
        (Literal::Int(i), FieldType::Integer) => Ok(DefaultValue::Integer(*i)),
        (Literal::Int(i), FieldType::Decimal { precision, scale }) => fits(Decimal::from(*i), *precision, *scale).map(DefaultValue::Decimal),
        (Literal::Decimal(d), FieldType::Decimal { precision, scale }) => fits(*d, *precision, *scale).map(DefaultValue::Decimal),
        (Literal::Str(s), FieldType::String { max_length }) => {
            if max_length.is_some_and(|m| s.chars().count() > m as usize) {
                Err(format!("text is longer than {}", max_length.unwrap_or(0)))
            } else {
                Ok(DefaultValue::String(s.clone()))
            }
        }
        (Literal::Str(s), FieldType::Date) if chrono_like_date(s) => Ok(DefaultValue::String(s.clone())),
        (_, t) => Err(format!("the value does not fit {}", t.describe())),
    }
}

fn chrono_like_date(s: &str) -> bool {
    s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' && s.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

/// A decimal fits Decimal(p, s) when it has at most s decimals and p - s integer digits.
pub fn fits(d: rust_decimal::Decimal, precision: u32, scale: u32) -> Result<String, String> {
    let n = d.normalize();
    if n.scale() > scale {
        return Err(format!("{d} has more than {scale} decimal places"));
    }
    let int_digits = n.trunc().abs().to_string().trim_start_matches('0').len() as u32;
    if int_digits > precision - scale {
        return Err(format!("{d} has more than {} digits before the decimal point", precision - scale));
    }
    let mut out = d;
    out.rescale(scale);
    Ok(out.to_string())
}

/// Parse a script and build its metadata in one step.
pub fn from_source(src: &str) -> (MetadataModel, Vec<Diagnostic>) {
    let parsed = vks_syntax::parse(src);
    let (model, mut diags) = build(&parsed.module);
    let mut all = parsed.diagnostics;
    all.append(&mut diags);
    (model, all)
}
