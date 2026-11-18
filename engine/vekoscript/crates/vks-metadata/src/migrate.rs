//! Logical migration planning. The engine decides *what* changes between two metadata
//! versions and which changes could destroy or invalidate data; the Java platform turns the
//! plan into SQL and refuses steps that need approval unless an administrator approved them.

use crate::{FieldMeta, FieldType, MetadataModel, RegisterMeta};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum MigrationStep {
    CreateCatalog { name: String },
    CreateDocument { name: String },
    CreateRows { document: String, rows: String },
    CreateRegister { name: String },
    AddField { object: String, rows: Option<String>, field: FieldMeta },
    ChangeField { object: String, rows: Option<String>, from: FieldMeta, to: FieldMeta },
    DropField { object: String, rows: Option<String>, field: String },
    DropRows { document: String, rows: String },
    DropObject { name: String },
    ChangeRegister { name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStep {
    #[serde(flatten)]
    pub step: MigrationStep,
    /// True when the step can lose or invalidate existing data.
    pub requires_approval: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub steps: Vec<PlannedStep>,
}

impl MigrationPlan {
    pub fn requires_approval(&self) -> bool {
        self.steps.iter().any(|s| s.requires_approval)
    }
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
    fn safe(&mut self, step: MigrationStep) {
        self.steps.push(PlannedStep { step, requires_approval: false, reason: None });
    }
    fn risky(&mut self, step: MigrationStep, reason: impl Into<String>) {
        self.steps.push(PlannedStep { step, requires_approval: true, reason: Some(reason.into()) });
    }
}

/// Is changing a column from `a` to `b` guaranteed to keep every existing value?
pub fn widening(a: &FieldType, b: &FieldType) -> bool {
    match (a, b) {
        (x, y) if x == y => true,
        (FieldType::String { max_length: Some(n) }, FieldType::String { max_length: m }) => m.is_none_or(|m| m >= *n),
        (FieldType::Decimal { precision: p1, scale: s1 }, FieldType::Decimal { precision: p2, scale: s2 }) => s2 >= s1 && (p2 - s2) >= (p1 - s1),
        (FieldType::Integer, FieldType::Decimal { precision, scale }) => precision - scale >= 19,
        (FieldType::Date, FieldType::DateTime) => true,
        _ => false,
    }
}

fn diff_fields(plan: &mut MigrationPlan, object: &str, rows: Option<&str>, old: &[FieldMeta], new: &[FieldMeta]) {
    for f in new {
        match old.iter().find(|o| o.name == f.name) {
            None => {
                if f.required && f.default.is_none() {
                    plan.risky(
                        MigrationStep::AddField { object: object.into(), rows: rows.map(Into::into), field: f.clone() },
                        format!("New required field \"{}\" has no default; existing records would have no value.", f.name),
                    );
                } else {
                    plan.safe(MigrationStep::AddField { object: object.into(), rows: rows.map(Into::into), field: f.clone() });
                }
            }
            Some(o) if o != f => {
                let mut reasons = Vec::new();
                if !widening(&o.ty, &f.ty) {
                    reasons.push(format!("type {} в†’ {} may not hold existing values", o.ty.describe(), f.ty.describe()));
                }
                if f.required && !o.required {
                    reasons.push("the field becomes required; existing records may be empty".to_string());
                }
                if f.unique && !o.unique {
                    reasons.push("the field becomes unique; existing records may have duplicates".to_string());
                }
                let step = MigrationStep::ChangeField { object: object.into(), rows: rows.map(Into::into), from: o.clone(), to: f.clone() };
                if reasons.is_empty() {
                    plan.safe(step);
                } else {
                    plan.risky(step, format!("Field \"{}\": {}.", f.name, reasons.join("; ")));
                }
            }
            _ => {}
        }
    }
    for o in old {
        if !new.iter().any(|f| f.name == o.name) {
            plan.risky(MigrationStep::DropField { object: object.into(), rows: rows.map(Into::into), field: o.name.clone() }, format!("Removing field \"{}\" deletes its data.", o.name));
        }
    }
}

fn register_changed(a: &RegisterMeta, b: &RegisterMeta) -> bool {
    a != b
}

/// Plan the storage changes needed to go from `old` (None for a new application) to `new`.
pub fn plan_migration(old: Option<&MetadataModel>, new: &MetadataModel) -> MigrationPlan {
    let empty = MetadataModel::default();
    let old = old.unwrap_or(&empty);
    let mut plan = MigrationPlan::default();

    for name in new.creation_order() {
        if let Some(c) = new.catalog(&name) {
            match old.catalog(&name) {
                None => plan.safe(MigrationStep::CreateCatalog { name: name.clone() }),
                Some(o) => diff_fields(&mut plan, &name, None, &o.fields, &c.fields),
            }
        } else if let Some(d) = new.document(&name) {
            match old.document(&name) {
                None => {
                    plan.safe(MigrationStep::CreateDocument { name: name.clone() });
                    for r in &d.rows {
                        plan.safe(MigrationStep::CreateRows { document: name.clone(), rows: r.name.clone() });
                    }
                }
                Some(o) => {
                    diff_fields(&mut plan, &name, None, &o.fields, &d.fields);
                    for r in &d.rows {
                        match o.rows.iter().find(|x| x.name == r.name) {
                            None => plan.safe(MigrationStep::CreateRows { document: name.clone(), rows: r.name.clone() }),
                            Some(or) => diff_fields(&mut plan, &name, Some(&r.name), &or.fields, &r.fields),
                        }
                    }
                    for or in &o.rows {
                        if !d.rows.iter().any(|r| r.name == or.name) {
                            plan.risky(MigrationStep::DropRows { document: name.clone(), rows: or.name.clone() }, format!("Removing rows \"{}\" deletes their data.", or.name));
                        }
                    }
                }
            }
        } else if let Some(r) = new.register(&name) {
            match old.register(&name) {
                None => plan.safe(MigrationStep::CreateRegister { name: name.clone() }),
                Some(o) if register_changed(o, r) => plan.risky(
                    MigrationStep::ChangeRegister { name: name.clone() },
                    "Changing a register's dimensions, measures or kind changes the meaning of existing movements; it must be rebuilt by reposting documents.",
                ),
                Some(_) => {}
            }
        }
    }
    for o in old.catalogs.iter().map(|c| &c.name).chain(old.documents.iter().map(|d| &d.name)).chain(old.registers.iter().map(|r| &r.name)) {
        let still = new.catalog(o).is_some() || new.document(o).is_some() || new.register(o).is_some();
        if !still {
            plan.risky(MigrationStep::DropObject { name: o.clone() }, format!("Removing \"{o}\" deletes all of its data."));
        }
    }
    plan
}
