# ADR 0001: JSON lines over stdio between the Java platform and the Rust worker

Status: accepted (2026-10-28)

## Context

The Java platform must run untrusted VekoScript in isolated Rust processes and answer the
scripts' platform calls inside its own database transaction. The protocol has to be versioned,
strongly typed, bidirectional (the worker calls back into Java mid-execution) and re-entrant
(Java starts nested executions for event handlers while a call is pending). It must carry
decimals and dates without loss.

## Options

| Option | For | Against |
| --- | --- | --- |
| gRPC + Protobuf over a socket | schema-first, generated code, streaming | needs a port or socket per worker, a gRPC server in every worker, bidirectional streams for callbacks; protobuf has no decimal type |
| JSON lines over the worker's stdin/stdout | no ports, the process boundary is the connection, trivial to inspect and replay, both sides have mature JSON libraries | schema enforced by code rather than generated; larger messages than binary |
| Shared library (JNI / FFM) | fastest calls | runs untrusted code inside the JVM process: no isolation, a crash takes down the platform |

## Decision

JSON lines over stdio with a versioned envelope (`vks/1`). The Rust types in `vks-protocol`
are the schema (serde, strict tagging); Java builds and reads the same shapes. Decimals and
dates travel as strings in tagged values. Nested calls are strictly LIFO, so each side reads
in order without a multiplexer.

## Consequences

- One worker serves one operation at a time; parallelism comes from the pool size.
- A misbehaving worker is simply killed; the pipe closing is the failure signal.
- Message encode/decode costs about 10 µs for a typical posting result (see
  [benchmarks.md](../benchmarks.md)), small next to database work.
- If a binary protocol becomes necessary, `vks/2` can switch encoding behind the same message
  model.
