# VekoScript engine

Rust workspace: parser, metadata, analyzer, sandboxed interpreter and the `vks` command-line
tool and worker. Documentation: [docs/vekoscript](../../docs/vekoscript/README.md).

```bash
cargo test --workspace
```

```bash
cargo run -p vks-cli -- run examples/tour.vks
```

```bash
cargo build --release -p vks-cli
```

The release binary `target/release/vks` is what the Java platform (`backend/`) starts as its
worker.
