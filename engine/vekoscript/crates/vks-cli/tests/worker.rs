//! The `vks worker` process speaking vks/1 over stdin/stdout. The test plays the platform:
//! it answers host calls and starts a nested handler execution while a call is pending.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use vks_metadata::ObjectKind;
use vks_protocol::{Entry, Envelope, ExecContext, HostCall, Limits, Message, Program, WireObject, WireRow, WireValue, PROTOCOL};
use vks_syntax::ast::Event;

const INVENTORY: &str = include_str!("../../../examples/inventory.vks");

struct Platform {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Platform {
    fn start() -> Platform {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vks")).arg("worker").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("worker starts");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Platform { child, input, output }
    }

    fn send_raw(&mut self, line: &str) {
        self.input.write_all(line.as_bytes()).unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
    }

    fn send(&mut self, id: u64, m: Message) {
        let line = serde_json::to_string(&Envelope::new(id, m)).unwrap();
        self.send_raw(&line);
    }

    fn recv(&mut self) -> Envelope {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad line {line:?}: {e}"))
    }
}

impl Drop for Platform {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn ctx() -> ExecContext {
    ExecContext {
        organization: "org-1".into(),
        user: "clerk".into(),
        application: "inventory".into(),
        script_version: 3,
        capabilities: vec!["*".into()],
        operation: "test".into(),
        now: "2026-10-28T09:30:00Z".into(),
        correlation_id: "c-1".into(),
        event_depth: 0,
        limits: Limits::default(),
    }
}

fn r#ref(type_name: &str, id: &str) -> WireValue {
    WireValue::Ref { kind: ObjectKind::Catalog, type_name: type_name.into(), id: id.into() }
}

fn product() -> WireObject {
    WireObject {
        kind: ObjectKind::Catalog,
        type_name: "Products".into(),
        id: Some("p-1".into()),
        version: Some(1),
        number: None,
        date: None,
        status: None,
        deleted: false,
        fields: BTreeMap::from([("code".into(), WireValue::Str("P-1001".into())), ("name".into(), WireValue::Str("Industrial Motor".into())), ("price".into(), WireValue::Dec("1250.00".into()))]),
        rows: BTreeMap::new(),
    }
}

#[test]
fn check_reports_metadata_handlers_and_diagnostics() {
    let mut p = Platform::start();
    p.send(1, Message::Check { source: INVENTORY.into(), script: false });
    let env = p.recv();
    assert_eq!((env.protocol.as_str(), env.id), (PROTOCOL, 1));
    let Message::CheckResult { diagnostics, metadata, handlers } = env.message else { panic!("{:?}", env.message) };
    assert!(diagnostics.is_empty());
    assert_eq!(metadata.unwrap().documents[0].name, "GoodsReceipt");
    assert!(handlers.iter().any(|h| h.target == "GoodsReceipt" && h.event == Event::Post));

    p.send(2, Message::Check { source: "catalog P { field x: Strng; }".into(), script: false });
    let Message::CheckResult { diagnostics, metadata, .. } = p.recv().message else { panic!() };
    assert!(metadata.is_none());
    assert_eq!(diagnostics[0].line, 1);
    assert_eq!(diagnostics[0].severity, "error");
}

#[test]
fn executes_with_host_calls_and_nested_handlers() {
    let mut p = Platform::start();
    let source = format!(
        "{INVENTORY}\n{}",
        r#"
        function receive() {
            let r = Document.GoodsReceipt.create(warehouse: Catalog.Warehouses.findById("w-1"), supplier: Catalog.Suppliers.findById("s-1"));
            r.items.add(product: Catalog.Products.findByCode("P-1001"), quantity: 4, unitPrice: 2.50);
            r.save();
            return r.total;
        }
        "#
    );
    p.send(10, Message::Execute { program: Program { key: "org-1/inventory/3".into(), source }, context: ctx(), entry: Entry::Function { name: "receive".into(), args: vec![] } });

    // The script asks for the warehouse, supplier and product.
    let (save_id, object) = loop {
        let env = p.recv();
        match env.message {
            Message::HostCall(HostCall::FindById { type_name, id, .. }) => {
                let mut o = product();
                o.type_name = type_name.clone();
                o.id = Some(id);
                o.fields = BTreeMap::from([("code".into(), WireValue::Str("X".into())), ("name".into(), WireValue::Str(format!("{type_name} X")))]);
                p.send(env.id, Message::HostResult { ok: Some(WireValue::Object(Box::new(o))), error: None });
            }
            Message::HostCall(HostCall::FindBy { field, value, .. }) => {
                assert_eq!((field.as_str(), value), ("code", WireValue::Str("P-1001".into())));
                p.send(env.id, Message::HostResult { ok: Some(WireValue::Object(Box::new(product()))), error: None });
            }
            Message::HostCall(HostCall::Save { object }) => {
                assert_eq!(object.rows["items"].len(), 1);
                break (env.id, object);
            }
            other => panic!("unexpected {other:?}"),
        }
    };

    // As the platform, run BeforeSave in the worker before answering the save.
    let mut nested = ctx();
    nested.event_depth = 1;
    p.send(
        11,
        Message::Execute {
            program: Program { key: "org-1/inventory/3".into(), source: String::new() },
            context: nested,
            entry: Entry::Handler { target: "GoodsReceipt".into(), event: Event::BeforeSave, object },
        },
    );
    // BeforeSave reads item.product.code only when rejecting; quantities are positive, so the
    // handler completes without host calls.
    let env = p.recv();
    assert_eq!(env.id, 11);
    let Message::ExecuteResult(r) = env.message else { panic!("{:?}", env.message) };
    assert!(r.ok, "{:?}", r.error);
    let mut computed = r.object.unwrap();
    assert_eq!(computed.fields["total"], WireValue::Dec("10.00".into()));
    assert_eq!(computed.rows["items"][0].fields["amount"], WireValue::Dec("10.00".into()));

    // Store it and answer the original save.
    computed.id = Some("gr-1".into());
    computed.version = Some(1);
    computed.number = Some("GR-000001".into());
    computed.rows.get_mut("items").unwrap()[0] = WireRow { line_no: Some(1), ..computed.rows["items"][0].clone() };
    p.send(save_id, Message::HostResult { ok: Some(WireValue::Object(Box::new(computed))), error: None });

    let env = p.recv();
    assert_eq!(env.id, 10);
    let Message::ExecuteResult(r) = env.message else { panic!("{:?}", env.message) };
    assert!(r.ok, "{:?}", r.error);
    assert_eq!(r.value, Some(WireValue::Dec("10.00".into())));
    assert_eq!(r.stats.host_calls, 4);
}

#[test]
fn post_handler_returns_intents_and_host_errors_become_script_errors() {
    let mut p = Platform::start();
    let mut doc = product();
    doc.kind = ObjectKind::Document;
    doc.type_name = "GoodsReceipt".into();
    doc.id = Some("gr-1".into());
    doc.status = Some("draft".into());
    doc.fields = BTreeMap::from([("warehouse".into(), r#ref("Warehouses", "w-1")), ("supplier".into(), r#ref("Suppliers", "s-1")), ("total".into(), WireValue::Dec("10.00".into()))]);
    doc.rows = BTreeMap::from([(
        "items".into(),
        vec![WireRow {
            line_no: Some(1),
            fields: BTreeMap::from([
                ("product".into(), r#ref("Products", "p-1")),
                ("quantity".into(), WireValue::Dec("4.000".into())),
                ("unitPrice".into(), WireValue::Dec("2.50".into())),
                ("amount".into(), WireValue::Dec("10.00".into())),
            ]),
        }],
    )]);
    let program = Program { key: "k".into(), source: INVENTORY.into() };
    p.send(1, Message::Execute { program: program.clone(), context: ctx(), entry: Entry::Handler { target: "GoodsReceipt".into(), event: Event::Post, object: doc.clone() } });
    let Message::ExecuteResult(r) = p.recv().message else { panic!() };
    assert!(r.ok, "{:?}", r.error);
    assert_eq!(r.intents.len(), 1);
    let vks_protocol::Intent::RegisterMovement { register, direction, dimensions, measures } = &r.intents[0] else { panic!() };
    assert_eq!((register.as_str(), *direction), ("StockBalance", vks_protocol::Direction::In));
    assert_eq!(dimensions["warehouse"], r#ref("Warehouses", "w-1"));
    assert_eq!(measures["quantity"], WireValue::Dec("4.000".into()));

    // BeforePost reads the supplier through its reference; the platform refuses access.
    p.send(2, Message::Execute { program, context: ctx(), entry: Entry::Handler { target: "GoodsReceipt".into(), event: Event::BeforePost, object: doc } });
    let env = p.recv();
    let Message::HostCall(HostCall::FindById { type_name, .. }) = env.message else { panic!("{:?}", env.message) };
    assert_eq!(type_name, "Suppliers");
    p.send(env.id, Message::HostResult { ok: None, error: Some(vks_protocol::HostError { code: "permission".into(), message: "clerk cannot read suppliers".into() }) });
    let Message::ExecuteResult(r) = p.recv().message else { panic!() };
    let e = r.error.unwrap();
    assert_eq!((e.code.as_str(), e.kind.as_str(), e.message.as_str()), ("VKS4300", "permission", "clerk cannot read suppliers"));
    assert!(r.intents.is_empty());
}

#[test]
fn protocol_errors_and_shutdown() {
    let mut p = Platform::start();
    p.send_raw("this is not json");
    assert!(matches!(p.recv().message, Message::ProtocolError { .. }));
    p.send_raw(r#"{"protocol":"vks/9","id":5,"type":"shutdown"}"#);
    let env = p.recv();
    assert_eq!(env.id, 5);
    let Message::ProtocolError { message } = env.message else { panic!() };
    assert!(message.contains("vks/1"));
    p.send(6, Message::HostResult { ok: None, error: None });
    assert!(matches!(p.recv().message, Message::ProtocolError { .. }));
    p.send(7, Message::Shutdown);
    let status = p.child.wait().unwrap();
    assert!(status.success());
}
