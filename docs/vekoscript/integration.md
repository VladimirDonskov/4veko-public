# Integration: worker protocol and platform API

```
 client ──HTTP/JSON──▶ Java platform (Spring Boot) ──JDBC──▶ PostgreSQL
                          │  ▲
              vks/1 JSON lines (stdin/stdout)
                          ▼  │
                    vks worker (Rust, one process per pooled slot)
```

The Rust engine never connects to PostgreSQL. It receives source, context and objects, and
answers with results, intents and host calls. Java owns transactions, storage, security and
validation. Why JSON lines over stdio: [adr/0001-json-lines-protocol.md](adr/0001-json-lines-protocol.md).

## Protocol `vks/1`

One JSON object per line. Every message is an envelope:

```json
{"protocol": "vks/1", "id": 7, "type": "execute", "payload": { ... }}
```

| Type | Direction | Payload |
| --- | --- | --- |
| `check` | platform → worker | `{source, script}` |
| `checkResult` | worker → platform | `{diagnostics, metadata \| null, handlers: [{target, event}]}` |
| `plan` | platform → worker | `{source, previous: metadata \| null}` |
| `planResult` | worker → platform | `{diagnostics, metadata, plan: {steps: [{op, ..., requiresApproval, reason}]}}` |
| `execute` | platform → worker | `{program: {key, source}, context, entry}` |
| `executeResult` | worker → platform | `{ok, value, object, intents, logs, error, stats}` |
| `hostCall` | worker → platform | `{op: findById \| findBy \| list \| save \| delete \| post \| reverse \| registerBalance, ...}` |
| `hostResult` | platform → worker | `{ok: value \| null, error: {code, message} \| null}` |
| `shutdown` | platform → worker | none |
| `protocolError` | either | `{message}` |

`context` is `{organization, user, application, scriptVersion, capabilities, operation, now,
correlationId, eventDepth, limits}`; `limits` may list any subset of the engine limits.
`entry` is `{kind: "script"}`, `{kind: "handler", target, event, object}` or
`{kind: "function", name, args}`.

A response carries its request's `id`. While an `execute` is running the worker may send
`hostCall`s and waits for the matching `hostResult`. Before answering, the platform may send
another `execute` (an event handler for an object the script is saving); the worker answers
the newest request first, so both sides read strictly in order. Worker-originated ids start at
2^48 so they never look like platform ids.

Values use an adjacently tagged form so decimals and dates survive JSON exactly:

```json
{"t": "dec", "v": "1250.00"}      {"t": "date", "v": "2026-10-28"}
{"t": "ref", "v": {"kind": "catalog", "type": "Products", "id": "…"}}
{"t": "map", "v": [["quantity", {"t": "dec", "v": "12.500"}]]}
```

Tags: `null bool int dec str date dateTime duration money array map ref object`. Objects
(`WireObject`) are `{kind, type, id, version, number, date, status, deleted, fields, rows}` with
rows as `{name: [{lineNo, fields}]}`. Intents are `{kind: "registerMovement", register,
direction: "in" | "out", dimensions, measures}`.

The authoritative definitions are the Rust types in `crates/vks-protocol/src/lib.rs`.
Compatibility rule: new optional fields may be added within `vks/1`; renaming, removing or
changing the meaning of a field requires `vks/2`, and the worker refuses envelopes of another
version.

## Platform REST API

Base path `/api/v1/apps/{app}`. Every request needs `Authorization: Bearer <token>`.
Decimals are strings, references are `{"type", "id"}` (an id string is accepted on input).

| Method and path | Capability | Purpose |
| --- | --- | --- |
| `POST /preview` `{source, expectedVersion}` | role `admin` | Check source against an exact base revision and return diagnostics, metadata and a storage plan. This operation writes nothing. |
| `PUT /` `{source, approveDestructive?, expectedVersion?}` | role `admin` | Publish a new revision. Studio sends the reviewed base version, or zero for creation. Older clients may omit the precondition. |
| `GET /` | any | current version, metadata, handlers |
| `POST /check` `{source}` | any | diagnostics without deploying |
| `GET /catalogs/{Type}?field=value&limit=&offset=` | `catalog.read` | list |
| `POST /catalogs/{Type}` `{fields}` | `catalog.write` | create (defaults apply) |
| `GET /catalogs/{Type}/{id}` | `catalog.read` | read |
| `PUT /catalogs/{Type}/{id}` `{version, fields}` | `catalog.write` | update (fields not sent are kept) |
| `DELETE /catalogs/{Type}/{id}` | `catalog.write` | archive |
| same under `/documents/{Type}` with `date` and `rows: {name: [ {field: value} ]}` | `document.*` | rows sent replace that row set |
| `POST /documents/{Type}/{id}/post` | `document.post` | post |
| `POST /documents/{Type}/{id}/reverse` | `document.post` | reverse |
| `GET /registers/{Register}/balance?dimension=value&at=YYYY-MM-DD` | `register.read` | totals of measures |
| `GET /registers/{Register}/movements?recorder={documentId}` | `register.read` | a document's movements (active and reversed) |
| `POST /functions/{name}` `{args: [...]}` | what the function does | run an application function |

`GET /health` needs no token.

### Errors

Errors are RFC 9457 problem details with `code`, `kind` and, for script errors, `line` and
`col`:

```json
{"status": 422, "detail": "Quantity must be greater than zero for P-1001.", "code": "VKS4100", "kind": "rejected", "line": 53, "col": 13}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| VKS1xxx–4xxx | 422 / 403 / 404 / 409 | from the engine (see [runtime.md](runtime.md#error-codes)) |
| VKS5001 | 404 | not found (also: application of another organization) |
| VKS5002 | 409 | conflict: changed by someone else, already posted, posted and cannot change |
| VKS5003 | 422 | validation by the platform |
| VKS5004 | 403 | missing capability or role |
| VKS5005 | 409 | deployment needs approval; `plan` included |
| VKS5006 | 503 | worker unavailable or exited |
| VKS5007 | 400 | malformed request |
| VKS5008 | 504 | script exceeded the platform's wall-clock timeout; worker was killed |
| VKS5009 | 502 | worker protocol error |
| VKS5010 | 422 | deployment has errors; `diagnostics` included |
| VKS5011 | 501 | not supported yet (accounting intents, information register queries) |
| VKS5012 | 500 | storage failure; the operation was rolled back |
| VKS5013 | 409 | preview or publication expected a different active version. Fetch the active source and review changes again. |

## Configuration

| Setting | Environment | Default |
| --- | --- | --- |
| `spring.datasource.url` | `VKS_DB_URL` | `jdbc:postgresql://localhost:5433/vekoscript` |
| `spring.datasource.username/password` | `VKS_DB_USER`, `VKS_DB_PASSWORD` | local development values |
| `vks.security.jwt-secret` | `VKS_JWT_SECRET` | none: required, ≥ 32 bytes |
| `vks.worker.command` | `VKS_WORKER` | `<engine-dir>/target/{release,debug}/vks` |
| `vks.worker.engine-dir` | `VKS_ENGINE_DIR` | `../engine/vekoscript` |
| `vks.worker.pool-size` | `VKS_WORKERS` | 4 |
| `vks.worker.timeout-ms` | `VKS_SCRIPT_TIMEOUT_MS` | 10000 |
| `vks.worker.max-memory-mb` | | 512 |
| `vks.limits.*` (`max-steps`, `max-millis`, ...) | | engine defaults |
| `vks.security.roles.<role>` | | `admin`, `clerk`, `viewer` |

## Running locally

```bash
cargo build --release -p vks-cli --manifest-path engine/vekoscript/Cargo.toml
```

```bash
docker exec veko-db-1 psql -U veko -d veko -c "create database vekoscript"
```

```bash
cd backend && VKS_JWT_SECRET=change-me-to-a-long-random-secret-value ./mvnw spring-boot:run
```

Tests: `cargo test --workspace` in `engine/vekoscript`; `./mvnw test` in `backend` (needs the
release binary and PostgreSQL with a `vekoscript_test` database; set `VKS_TEST_DB_URL` to use
another one).
