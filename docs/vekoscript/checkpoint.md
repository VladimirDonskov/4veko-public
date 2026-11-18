# Checkpoint: VekoScript (2026-10-28)

Resume from the [ecosystem engineering checkpoint](../product/implementation-progress.md) for the current working tree, test results and pending integration. This document preserves the earlier engine milestone.

## Where things stand

| Phase | State |
| --- | --- |
| 1. Language core: lexer, parser, AST, diagnostics, interpreter, standard library, limits, CLI | Done and tested |
| 2. Metadata: language, validator, registry, migration planner | Done and tested |
| 3. Business runtime: catalogs, documents, rows, references, events, intents, balances | Done and tested (accumulation registers; information registers partial) |
| 4. Java platform: worker pool and protocol, generated storage, deploy with approval, CRUD, posting, reversal, balances, audit, outbox, JWT capabilities | Done; 17-step demo tested on PostgreSQL |
| 5. Editor support | Diagnostics contract done; LSP and Monaco configurator planned |
| 6. Hardening | Fuzz-style tests, OS limits and benchmarks done; see open items |

Test counts at this checkpoint: Rust 56 (`cargo test --workspace` in `engine/vekoscript`),
Java 5 (`./mvnw test` in `backend`). Clippy and rustfmt are clean.

Not committed yet. The TypeScript prototype is commit `75e3727` (local, not pushed).

## Layout

```
engine/vekoscript/            Rust workspace (see runtime.md for crates)
  examples/inventory.vks      reference application (demo)
  examples/tour.vks           language tour (run by a test)
backend/                      Spring Boot 4.1 platform (Java 21+, Maven Wrapper)
  src/main/java/com/fourveko/platform/
    worker/                   process, pool, session (vks/1)
    app/                      deploy, versions, migrations
    storage/                  generated tables, objects, registers
    runtime/PlatformService   operations, handlers, host calls, posting, outbox
    api/                      REST controller, problem details, plain JSON
    security/                 JWT, roles → capabilities
  src/test/.../InventoryDemoTest, WorkerTimeoutTest
docs/vekoscript/              this documentation
.github/workflows/vekoscript.yml   CI for engine + platform (not run yet: nothing pushed)
```

## How to continue

Toolchains on this machine: Rust at `%USERPROFILE%\.cargo\bin` (not on PATH; prepend it),
JDK 25 on PATH (`C:\java\jdk-25.0.4+7`, set `JAVA_HOME` for the wrapper), PostgreSQL 17 in
container `veko-db-1` on port 5433 with databases `vekoscript` and `vekoscript_test`.

1. Build the worker (the Java tests use the release binary):

   ```bash
   cargo build --release -p vks-cli --manifest-path engine/vekoscript/Cargo.toml
   ```

2. Engine tests, lint and format:

   ```bash
   cargo test --workspace --manifest-path engine/vekoscript/Cargo.toml
   ```

3. Platform tests (real PostgreSQL, real worker):

   ```bash
   cd backend && ./mvnw -B test
   ```

## Open items, in suggested order

1. **Commit** this work (engine, backend, docs, CI) after review; push when wanted. The CI
   workflow has not run yet; first run will show whether the Linux `RLIMIT_AS` of 512 MiB suits
   the worker.
2. **Monaco configurator** in `apps/web` against the Java check/deploy endpoints; then remove
   the TypeScript prototype (`apps/api/src/lang`, `apps/api/src/modules/config`, web
   `/configurator` and `/x` pages) as agreed in ADR 0002.
3. **Language server** (`vks lsp`) reusing the analyzer's type knowledge for hover and
   completion.
4. **Information registers**: script writes (`set`), periodic slices, balance semantics.
5. **Money fields** in metadata; accounting entries end to end (protocol type exists).
6. **Idempotency keys** on mutating REST calls; rate limits; row-level permissions.
7. **Performance**: bytecode for the interpreter if profiles warrant; a Java+PostgreSQL
   posting benchmark.
8. **Coverage-guided fuzzing** with `cargo fuzz` (nightly) on parser and interpreter.
9. Move TypeScript ERP modules (ledger, sales, inventory, procurement) to VekoScript on the
   Java platform one at a time (ADR 0002).

Nothing has been deployed anywhere.
