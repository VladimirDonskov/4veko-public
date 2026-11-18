//! Business runtime: the inventory application (examples/inventory.vks) against the in-memory
//! platform. Catalogs, documents with rows, event handlers, posting intents, balances,
//! reversal, permissions and rollback.

use std::rc::Rc;
use vks_protocol::{Direction, Entry, ExecContext, ExecuteResult, Limits, WireValue};
use vks_runtime::{compile, execute, MemoryHost, Options, Program};

const INVENTORY: &str = include_str!("../../../examples/inventory.vks");

const SETUP: &str = r#"
function setup() {
    let p = Catalog.Products.create(code: "P-1001", name: "Industrial Motor", price: 1250.00);
    p.save();
    let w = Catalog.Warehouses.create(code: "MAIN", name: "Main warehouse");
    w.save();
    let s = Catalog.Suppliers.create(code: "S-1", name: "Acme Supply");
    s.save();
}
"#;

struct World {
    program: Rc<Program>,
    host: MemoryHost,
}

fn ctx(capabilities: &[&str]) -> ExecContext {
    ExecContext {
        organization: "org-1".into(),
        user: "clerk".into(),
        application: "inventory".into(),
        script_version: 1,
        capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
        operation: "test".into(),
        now: "2026-10-28T09:30:00Z".into(),
        correlation_id: "t-1".into(),
        event_depth: 0,
        limits: Limits::default(),
    }
}

const ALL: &[&str] = &["*"];

impl World {
    fn new(extra: &str) -> World {
        let src = format!("{INVENTORY}\n{SETUP}\n{extra}");
        let (program, diags) = compile(&src, Options { allow_script: false });
        let program = Rc::new(program.unwrap_or_else(|| panic!("{diags:#?}")));
        let host = MemoryHost::new(program.clone());
        let mut w = World { program, host };
        w.call_ok("setup", ALL);
        w
    }

    fn call(&mut self, function: &str, caps: &[&str]) -> ExecuteResult {
        execute(&self.program, &ctx(caps), &Entry::Function { name: function.into(), args: vec![] }, &mut self.host)
    }

    fn call_ok(&mut self, function: &str, caps: &[&str]) -> Option<WireValue> {
        let r = self.call(function, caps);
        assert!(r.ok, "{function}: {:?}", r.error);
        r.value
    }

    fn receipts(&self) -> Vec<(Option<String>, Option<String>, WireValue)> {
        self.host.objects("GoodsReceipt").iter().map(|o| (o.number.clone(), o.status.clone(), o.fields.get("total").cloned().unwrap_or(WireValue::Null))).collect()
    }
}

fn arr(v: Option<WireValue>) -> Vec<WireValue> {
    match v {
        Some(WireValue::Array(a)) => a,
        other => panic!("expected an array, got {other:?}"),
    }
}

fn dec(s: &str) -> WireValue {
    WireValue::Dec(s.into())
}

const RECEIVE: &str = r#"
function receive() {
    let p = Catalog.Products.findByCode("P-1001");
    let r = Document.GoodsReceipt.create(
        warehouse: Catalog.Warehouses.findByCode("MAIN"),
        supplier: Catalog.Suppliers.findByCode("S-1"),
        supplierInvoice: "INV-77"
    );
    r.items.add(product: p, quantity: 10, unitPrice: 250.00);
    r.items.add(product: p, quantity: 2.5, unitPrice: 100.00);
    r.post();
    let b = Register.StockBalance.balance(product: p, warehouse: r.warehouse);
    return [r.number, r.status, r.total, r.items.get(1).amount, b.quantity, b.amount];
}

function balance() {
    let b = Register.StockBalance.balance(product: Catalog.Products.findByCode("P-1001"));
    return [b.quantity, b.amount];
}

function reverseFirst() {
    let r = Document.GoodsReceipt.findByNumber("GR-000001");
    r.reverse();
    return r.status;
}

function postAgain() {
    let r = Document.GoodsReceipt.findByNumber("GR-000001");
    r.post();
}
"#;

#[test]
fn creates_posts_and_balances_a_goods_receipt() {
    let mut w = World::new(RECEIVE);
    let v = arr(w.call_ok("receive", ALL));
    assert_eq!(v, vec![WireValue::Str("GR-000001".into()), WireValue::Str("posted".into()), dec("2750.00"), dec("250.00"), dec("12.500"), dec("2750.00")]);

    // Two movements, one per line, recorded by the receipt.
    let m = w.host.movements();
    assert_eq!(m.len(), 2);
    assert!(m.iter().all(|m| m.register == "StockBalance" && m.direction == Direction::In && m.active && m.recorder_type == "GoodsReceipt"));
    assert_eq!(m[0].measures.get("quantity"), Some(&dec("10.000")));
    assert_eq!(m[0].period, "2026-10-28");

    // AfterPost ran after commit.
    assert_eq!(w.host.notifications, vec!["Received 2 line(s) into Main warehouse.".to_string()]);
}

#[test]
fn reversal_recalculates_and_duplicate_posting_is_refused() {
    let mut w = World::new(RECEIVE);
    w.call_ok("receive", ALL);

    let again = w.call("postAgain", ALL);
    assert!(!again.ok);
    assert!(again.error.unwrap().message.contains("already posted"));
    assert_eq!(w.host.movements().len(), 2, "a refused posting changes nothing");

    assert_eq!(w.call_ok("reverseFirst", ALL), Some(WireValue::Str("reversed".into())));
    assert_eq!(arr(w.call_ok("balance", ALL)), vec![dec("0.000"), dec("0.00")]);
    assert!(w.host.movements().iter().all(|m| !m.active), "reversed movements stay for audit but no longer count");

    // A reversed receipt can be posted again.
    assert!(w.call("postAgain", ALL).ok);
    assert_eq!(arr(w.call_ok("balance", ALL)), vec![dec("12.500"), dec("2750.00")]);
}

#[test]
fn before_save_rejection_rolls_back_everything() {
    let mut w = World::new(
        r#"
        function badReceipt() {
            let r = Document.GoodsReceipt.create(warehouse: Catalog.Warehouses.findByCode("MAIN"), supplier: Catalog.Suppliers.findByCode("S-1"));
            r.items.add(product: Catalog.Products.findByCode("P-1001"), quantity: 0, unitPrice: 5.00);
            r.save();
        }
        function emptyReceipt() {
            let r = Document.GoodsReceipt.create(warehouse: Catalog.Warehouses.findByCode("MAIN"), supplier: Catalog.Suppliers.findByCode("S-1"));
            r.post();
        }
    "#,
    );
    let r = w.call("badReceipt", ALL);
    let e = r.error.unwrap();
    assert_eq!((e.kind.as_str(), e.message.as_str()), ("rejected", "Quantity must be greater than zero for P-1001."));
    assert!(w.receipts().is_empty());

    // post() saves first; the save commits as a draft, then BeforePost refuses the posting.
    let e = w.call("emptyReceipt", ALL).error.unwrap();
    assert_eq!((e.kind.as_str(), e.message.as_str()), ("rejected", "Cannot post an empty receipt."));
    assert_eq!(w.receipts(), vec![(Some("GR-000001".into()), Some("draft".into()), dec("0.00"))]);
    assert!(w.host.movements().is_empty());
}

#[test]
fn archived_supplier_blocks_posting() {
    let mut w = World::new(&format!(
        "{RECEIVE}\n{}",
        r#"
        function draft() {
            let r = Document.GoodsReceipt.create(warehouse: Catalog.Warehouses.findByCode("MAIN"), supplier: Catalog.Suppliers.findByCode("S-1"));
            r.items.add(product: Catalog.Products.findByCode("P-1001"), quantity: 1, unitPrice: 1.00);
            r.save();
        }
        function archiveSupplier() { Catalog.Suppliers.findByCode("S-1").delete(); }
        "#
    ));
    w.call_ok("draft", ALL);
    w.call_ok("archiveSupplier", ALL);
    let e = w.call("postAgain", ALL).error.unwrap();
    assert_eq!((e.kind.as_str(), e.message.as_str()), ("rejected", "The supplier Acme Supply is archived."));
    assert!(w.host.movements().is_empty());
}

#[test]
fn failure_while_applying_movements_rolls_back_the_posting() {
    let mut w = World::new(RECEIVE);
    w.host.fail_next_apply = true;
    let r = w.call("receive", ALL);
    assert!(!r.ok);
    assert!(w.host.movements().is_empty(), "no partial movements");
    // The draft saved before posting remains; its status did not change.
    assert_eq!(w.receipts(), vec![(Some("GR-000001".into()), Some("draft".into()), dec("2750.00"))]);
    // Retrying works.
    assert!(w.call("postAgain", ALL).ok);
    assert_eq!(w.host.movements().len(), 2);
}

#[test]
fn historical_balances() {
    let mut w = World::new(
        r#"
        function receiveOn(day, qty) {
            let r = Document.GoodsReceipt.create(warehouse: Catalog.Warehouses.findByCode("MAIN"), supplier: Catalog.Suppliers.findByCode("S-1"));
            r.date = day;
            r.items.add(product: Catalog.Products.findByCode("P-1001"), quantity: qty, unitPrice: 1.00);
            r.post();
        }
        function scenario() {
            receiveOn(date("2026-10-01"), 5);
            receiveOn(date("2026-10-20"), 7);
            let p = Catalog.Products.findByCode("P-1001");
            return [
                Register.StockBalance.balance(product: p, at: date("2026-09-30")).quantity,
                Register.StockBalance.balance(product: p, at: date("2026-10-10")).quantity,
                Register.StockBalance.balance(product: p).quantity
            ];
        }
    "#,
    );
    assert_eq!(arr(w.call_ok("scenario", ALL)), vec![dec("0.000"), dec("5.000"), dec("12.000")]);
}

#[test]
fn unauthorized_operations_are_rejected() {
    let mut w = World::new(RECEIVE);
    let readonly = &["catalog.read", "document.read", "register.read"];
    let e = w.call("receive", readonly).error.unwrap();
    assert_eq!((e.code.as_str(), e.kind.as_str()), ("VKS4300", "permission"));
    assert!(e.message.contains("document.write"), "{}", e.message);
    // Can save but not post.
    let e = w.call("receive", &["catalog.read", "document.read", "document.write", "register.read"]).error.unwrap();
    assert!(e.message.contains("document.post"), "{}", e.message);
    assert!(w.host.movements().is_empty());
}

#[test]
fn field_types_are_enforced_without_silent_rounding() {
    let mut w = World::new(
        r#"
        function tooPrecise() { let p = Catalog.Products.create(code: "X", name: "X"); p.price = 10.005; }
        function tooLong() { let p = Catalog.Products.create(code: "THIS-CODE-IS-FAR-TOO-LONG", name: "X"); }
        function wrongRef() { let r = Document.GoodsReceipt.create(); r.warehouse = Catalog.Suppliers.findByCode("S-1"); }
        function unsaved() { let r = Document.GoodsReceipt.create(); r.warehouse = Catalog.Warehouses.create(code: "N", name: "New"); }
        function missingRequired() { let p = Catalog.Products.create(code: "Y"); p.save(); }
        function duplicateCode() { let p = Catalog.Products.create(code: "P-1001", name: "Dup"); p.save(); }
        function staleVersion() {
            let a = Catalog.Products.findByCode("P-1001");
            let b = Catalog.Products.findByCode("P-1001");
            a.price = 1.00; a.save();
            b.price = 2.00; b.save();
        }
    "#,
    );
    let code = |w: &mut World, f: &str| w.call(f, ALL).error.map(|e| (e.code, e.message)).unwrap();
    let (c, m) = code(&mut w, "tooPrecise");
    assert_eq!(c, "VKS4014");
    assert!(m.contains("round"), "{m}");
    assert_eq!(code(&mut w, "tooLong").0, "VKS4014");
    assert_eq!(code(&mut w, "wrongRef").0, "VKS4014");
    assert_eq!(code(&mut w, "unsaved").0, "VKS4019");
    let (c, m) = code(&mut w, "missingRequired");
    assert_eq!(c, "VKS4021");
    assert!(m.contains("\"name\""), "{m}");
    let (c, m) = code(&mut w, "duplicateCode");
    assert_eq!(c, "VKS4402");
    assert!(m.contains("already has code P-1001"), "{m}");
    assert_eq!(code(&mut w, "staleVersion").0, "VKS4403");
}

#[test]
fn handlers_cannot_misuse_their_own_object() {
    let src = r#"
        catalog Items { field code: String(10) required; field note: String(50); }
        document Order { field item: Ref<Items>; rows lines { field qty: Integer; } }
        register Counts { dimension item: Ref<Items>; measure qty: Integer; }
        on Items.BeforeSave(item) { item.save(); }
        on Order.BeforePost(order) { order.item = null; }
        on Order.Post(order) {
            for line in order.lines { Register.Counts.increase(item: order.item, qty: line.qty); }
        }
        function saveItem() { let i = Catalog.Items.create(code: "A"); i.save(); }
    "#;
    let (program, diags) = compile(src, Options::default());
    let program = Rc::new(program.unwrap_or_else(|| panic!("{diags:#?}")));
    let mut host = MemoryHost::new(program.clone());
    let r = execute(&program, &ctx(ALL), &Entry::Function { name: "saveItem".into(), args: vec![] }, &mut host);
    let e = r.error.unwrap();
    assert!(e.message.contains("inside its own BeforeSave handler"), "{}", e.message);
}

#[test]
fn movements_only_while_posting() {
    // Statically: a non-Post handler.
    let (_, d) = compile(
        r#"
        catalog Items { field code: String(10); }
        document Order { field item: Ref<Items>; }
        register Counts { dimension item: Ref<Items>; measure qty: Integer; }
        on Order.BeforePost(order) { Register.Counts.increase(item: order.item, qty: 1); }
    "#,
        Options::default(),
    );
    assert!(d.iter().any(|d| d.code == "VKS3016"), "{d:#?}");

    // At run time: a function called outside posting.
    let mut w = World::new(r#"function sneaky() { Register.StockBalance.increase(product: Catalog.Products.findByCode("P-1001"), warehouse: Catalog.Warehouses.findByCode("MAIN"), quantity: 1); }"#);
    let e = w.call("sneaky", ALL).error.unwrap();
    assert_eq!(e.code, "VKS4018");
}

#[test]
fn metadata_aware_semantic_checks() {
    let check = |logic: &str| -> Vec<&'static str> {
        let src = format!("{INVENTORY}\n{logic}");
        compile(&src, Options::default()).1.iter().map(|d| d.code).collect()
    };
    assert_eq!(check("on GoodsReceipt.BeforeCreate(document) { document.totl = 1; }"), ["VKS3012"]);
    assert_eq!(check("on GoodsReceipt.BeforeCreate(document) { for item in document.items { item.qty = 1; } }"), ["VKS3012"]);
    assert_eq!(check("on GoodsReceipt.BeforeCreate(document) { let x = document.supplier.nme; }"), ["VKS3012"]);
    assert_eq!(check("on GoodsReceipt.BeforeCreate(document) { document.number = \"X\"; }"), ["VKS3017"]);
    assert_eq!(check("on GoodsReceipt.BeforeCreate(document) { document.date = today(); }"), Vec::<&str>::new());
    assert!(check("function f() { return Catalog.Customers.create(); }").contains(&"VKS3010"));
    assert!(check("function f() { return Document.GoodsReceipt.findByCode(\"x\"); }").contains(&"VKS3014"));
    assert!(check("on Products.Post(p) { }").contains(&"VKS3011"));
    assert!(check("on StockBalance.BeforeSave(r) { }").contains(&"VKS3009"));
    assert_eq!(check("function move(p) { Register.StockBalance.increase(product: p, quantity: 1); }"), ["VKS3015"]);
    assert_eq!(check("function move(p, w) { Register.StockBalance.increase(product: p, warehouse: w, qty: 1); }"), ["VKS3015"]);
    assert_eq!(check("function move(p, w) { Register.StockBalance.decrease(p, w); }"), ["VKS3015"]);
    assert!(check("on GoodsReceipt.AfterPost(d) { } on GoodsReceipt.AfterPost(e) { }").contains(&"VKS3013"));
    // A reassigned variable is no longer checked statically.
    assert!(check("on GoodsReceipt.BeforeDelete(document) { let x = document; x = { totl: 1 }; let y = x.totl; }").is_empty());
}
