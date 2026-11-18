use vks_metadata::*;

const INVENTORY: &str = include_str!("../../../examples/inventory.vks");

fn codes(src: &str) -> Vec<&'static str> {
    from_source(src).1.iter().map(|d| d.code).collect()
}

#[test]
fn builds_the_inventory_application() {
    let (model, diags) = from_source(INVENTORY);
    assert!(diags.is_empty(), "{diags:#?}");
    assert_eq!(model.catalogs.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Products", "Warehouses", "Suppliers"]);
    let code = &model.catalog("Products").unwrap().fields[0];
    assert!(code.required && code.unique);
    assert_eq!(code.ty, FieldType::String { max_length: Some(20) });
    assert_eq!(model.catalog("Products").unwrap().fields[3].default, Some(DefaultValue::Decimal("0.00".into())));
    let receipt = model.document("GoodsReceipt").unwrap();
    assert_eq!(receipt.rows[0].name, "items");
    assert_eq!(receipt.fields[0].ty, FieldType::Ref { target: "Warehouses".into(), target_kind: ObjectKind::Catalog });
    let reg = model.register("StockBalance").unwrap();
    assert_eq!(reg.ty, RegisterType::Accumulation);
    assert!(reg.dimensions.iter().all(|d| d.required));
}

#[test]
fn orders_objects_so_references_come_first() {
    let (model, _) = from_source(INVENTORY);
    let order = model.creation_order();
    let pos = |n: &str| order.iter().position(|x| x == n).unwrap();
    assert!(pos("Products") < pos("GoodsReceipt"));
    assert!(pos("Warehouses") < pos("StockBalance"));
    // Mutual references are allowed and still ordered.
    let (m, d) = from_source("catalog A { field b: Ref<B>; } catalog B { field a: Ref<A>; }");
    assert!(d.is_empty());
    assert_eq!(m.creation_order().len(), 2);
}

#[test]
fn rejects_invalid_metadata_with_specific_codes() {
    assert!(codes("catalog Products { field code: String; } catalog Products { field x: String; }").contains(&"VKS2003"));
    assert!(codes("catalog Catalog { field x: String; }").contains(&"VKS2001"));
    assert!(codes("catalog lower { field x: String; }").contains(&"VKS2002"));
    assert!(codes("catalog P { field id: String; }").contains(&"VKS2005"));
    assert!(codes("catalog P { field Name: String; }").contains(&"VKS2006"));
    assert!(codes("catalog P { field a: String; field a: Integer; }").contains(&"VKS2007"));
    assert!(codes("register R { dimension amount: Decimal(18, 2); measure q: Integer; }").contains(&"VKS2008"));
    assert!(codes("register R { dimension code: String(10); measure label: String(5); }").contains(&"VKS2009"));
    assert!(codes("catalog P { field active: Boolean unique; }").contains(&"VKS2010"));
    assert!(codes("catalog P { field price: Decimal(5, 2) default 1234.5; }").contains(&"VKS2012"));
    assert!(codes("catalog P { field price: Decimal(5, 2) default 1.005; }").contains(&"VKS2012"));
    assert!(codes("catalog P { field n: String(3) default \"long\"; }").contains(&"VKS2012"));
    assert!(codes("catalog P { }").contains(&"VKS2013"));
    assert!(codes("register R { measure q: Integer; }").contains(&"VKS2014"));
    assert!(codes("catalog P { field s: String(0); }").contains(&"VKS2015"));
    assert!(codes("catalog P { field d: Decimal(30, 2); }").contains(&"VKS2016"));
    assert!(codes("catalog P { field d: Decimal(5, 6); }").contains(&"VKS2016"));
    assert!(codes("document D { field c: Ref<Customers>; }").contains(&"VKS2017"));
    assert!(codes("document D { field items: String; rows items { field x: Integer; } }").contains(&"VKS2007"));
    assert!(codes("document D { field number: String; }").contains(&"VKS2005"));
}

#[test]
fn fingerprints_and_registry_versions() {
    let (a, _) = from_source(INVENTORY);
    let (b, _) = from_source(&INVENTORY.replace("String(200)", "String(250)"));
    assert_eq!(a.fingerprint(), from_source(INVENTORY).0.fingerprint());
    assert_ne!(a.fingerprint(), b.fingerprint());
    let mut reg = MetadataRegistry::new();
    assert_eq!(reg.register(a.clone()).version, 1);
    assert_eq!(reg.register(a).version, 1, "identical metadata is not a new version");
    assert_eq!(reg.register(b).version, 2);
    assert_eq!(reg.get(1).unwrap().version, 1);
    assert_eq!(reg.current().unwrap().version, 2);
}

#[test]
fn plans_a_new_application_as_safe_creates_in_dependency_order() {
    let (model, _) = from_source(INVENTORY);
    let plan = plan_migration(None, &model);
    assert!(!plan.requires_approval());
    let ops: Vec<String> = plan.steps.iter().map(|s| format!("{:?}", s.step)).collect();
    let pos = |needle: &str| ops.iter().position(|o| o.contains(needle)).unwrap();
    assert!(pos("CreateCatalog { name: \"Products\"") < pos("CreateDocument { name: \"GoodsReceipt\""));
    assert!(ops.iter().any(|o| o.contains("CreateRows")));
    assert!(ops.iter().any(|o| o.contains("CreateRegister")));
}

#[test]
fn classifies_safe_and_destructive_changes() {
    let (v1, _) = from_source(INVENTORY);

    // Widening a string and adding an optional field are safe.
    let (v2, _) = from_source(&INVENTORY.replace("field name: String(200) required;\n    field unit", "field name: String(250) required;\n    field barcode: String(30);\n    field unit"));
    let plan = plan_migration(Some(&v1), &v2);
    assert!(!plan.requires_approval(), "{plan:#?}");
    assert!(plan.steps.iter().any(|s| matches!(&s.step, MigrationStep::AddField { field, .. } if field.name == "barcode")));

    // Narrowing a decimal, dropping a field, adding a required field without default: approval needed.
    let (v3, _) = from_source(
        &INVENTORY
            .replace("field price: Decimal(18, 2) default 0;", "field price: Decimal(10, 1) default 0;")
            .replace("field paymentTermsDays: Integer default 30;", "field taxId: String(20) required;"),
    );
    let plan = plan_migration(Some(&v1), &v3);
    assert!(plan.requires_approval());
    let risky: Vec<&str> = plan.steps.iter().filter(|s| s.requires_approval).map(|s| s.reason.as_deref().unwrap()).collect();
    assert!(risky.iter().any(|r| r.contains("price")), "{risky:?}");
    assert!(risky.iter().any(|r| r.contains("paymentTermsDays")), "{risky:?}");
    assert!(risky.iter().any(|r| r.contains("taxId")), "{risky:?}");

    // Changing a register or removing an object needs approval too.
    let (v4, _) = from_source(&INVENTORY.replace("    measure amount: Decimal(18, 2);\n", "").replace("catalog Suppliers", "catalog Vendors").replace("Ref<Suppliers>", "Ref<Vendors>"));
    let plan = plan_migration(Some(&v1), &v4);
    assert!(plan.steps.iter().any(|s| s.requires_approval && matches!(&s.step, MigrationStep::ChangeRegister { .. })));
    assert!(plan.steps.iter().any(|s| s.requires_approval && matches!(&s.step, MigrationStep::DropObject { name } if name == "Suppliers")));
}

#[test]
fn widening_rules() {
    use FieldType::*;
    assert!(migrate_widening(&String { max_length: Some(20) }, &String { max_length: Some(40) }));
    assert!(!migrate_widening(&String { max_length: Some(40) }, &String { max_length: Some(20) }));
    assert!(migrate_widening(&Decimal { precision: 18, scale: 2 }, &Decimal { precision: 20, scale: 3 }));
    assert!(!migrate_widening(&Decimal { precision: 18, scale: 2 }, &Decimal { precision: 18, scale: 3 }));
    assert!(migrate_widening(&Integer, &Decimal { precision: 21, scale: 2 }));
    assert!(!migrate_widening(&Decimal { precision: 10, scale: 0 }, &Integer));
}

fn migrate_widening(a: &FieldType, b: &FieldType) -> bool {
    let fa = FieldMeta { name: "x".into(), ty: a.clone(), required: false, unique: false, default: None };
    let fb = FieldMeta { ty: b.clone(), ..fa.clone() };
    let m1 = MetadataModel { catalogs: vec![CatalogMeta { name: "C".into(), fields: vec![fa] }], ..Default::default() };
    let m2 = MetadataModel { catalogs: vec![CatalogMeta { name: "C".into(), fields: vec![fb] }], ..Default::default() };
    !plan_migration(Some(&m1), &m2).requires_approval()
}
