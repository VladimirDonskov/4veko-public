# VekoScript

VekoScript (`.vks`) is the native business language of 4VEKO: declare catalogs, documents and
registers, then write functions and event handlers against them. The platform does
persistence, transactions, permissions and event dispatch.

| Document | Contents |
| --- | --- |
| [specification.md](specification.md) | the language: values, operators, conversions, scoping, errors |
| [grammar.md](grammar.md) | complete EBNF and disambiguation rules |
| [metadata.md](metadata.md) | catalogs, documents, registers, field types, validation, migrations |
| [events.md](events.md) | handlers, the operation lifecycle, posting, after-commit events |
| [runtime.md](runtime.md) | engine architecture, standard library, limits, error codes, **status** |
| [security.md](security.md) | threat model, sandbox, capabilities, tenant isolation |
| [integration.md](integration.md) | `vks/1` worker protocol, platform REST API, configuration |
| [editor.md](editor.md) | diagnostics contract for editors; LSP and Monaco plans |
| [benchmarks.md](benchmarks.md) | measured engine performance |
| [adr/](adr) | decisions: JSON-lines protocol, Java platform scope |
| [checkpoint.md](checkpoint.md) | where the work stands and how to continue |

## Five-minute tour

From `engine/vekoscript`:

```bash
cargo run -p vks-cli -- run examples/tour.vks
```

```bash
cargo run -p vks-cli -- check examples/inventory.vks
```

```bash
cargo run -p vks-cli -- plan examples/inventory.vks
```

The inventory application ([examples/inventory.vks](../../engine/vekoscript/examples/inventory.vks))
is the reference demo: three catalogs, a goods receipt with lines, a stock register and a
posting handler. It runs end to end against PostgreSQL in
[`InventoryDemoTest`](../../backend/src/test/java/com/fourveko/platform/InventoryDemoTest.java).

VekoScript is an independent design. Nothing in it is taken from 1C's language, runtime,
libraries, documentation or database structures.
