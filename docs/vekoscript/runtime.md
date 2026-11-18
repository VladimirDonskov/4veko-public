# VekoScript runtime

The engine is a Rust workspace in [`engine/vekoscript`](../../engine/vekoscript):

| Crate | Role |
| --- | --- |
| `vks-syntax` | Lexer, parser, AST, diagnostics with line/column/offset |
| `vks-metadata` | Metadata model, validator, registry, migration planner |
| `vks-protocol` | `vks/1` wire types shared with the Java platform |
| `vks-runtime` | Semantic analyzer, interpreter, standard library, limits, in-memory test platform |
| `vks-cli` | The `vks` tool and the isolated `vks worker` process |

## How a script runs

1. **Parse** (`vks-syntax`): tokens → AST. Errors carry codes `VKS1xxx` and positions; the
   parser recovers and keeps reporting. Nesting deeper than 100 levels is refused (VKS1199)
   instead of overflowing the stack.
2. **Metadata** (`vks-metadata`): declarations → an immutable `MetadataModel` (`VKS2xxx`).
3. **Analysis** (`vks-runtime::compile`): names resolve to local slots, functions, built-ins
   and platform services; the analyzer checks scoping, arity, assignments, loops, handler
   targets and events, and member names wherever it knows the type of a value (a handler's
   object, a row of a declared row set, a reference field, a manager such as
   `Catalog.Products`) (`VKS3xxx`). A program with errors never runs.
4. **Execution** (`vks-runtime::interp`): a tree-walking interpreter over the analyzed tree.
   Every platform operation is a typed `HostCall` to the `Host` trait. Errors carry `VKS4xxx`
   codes, a kind and the position of the expression that failed.

The interpreter has no access to the filesystem, processes, network, environment variables,
clock (other than the execution's fixed `now`), randomness or the database. There is no
`eval`, reflection, FFI or module loading.

## Values

| Type | Representation | Notes |
| --- | --- | --- |
| Null, Boolean | | |
| Integer | `i64` | checked arithmetic |
| Decimal | `rust_decimal` (96-bit mantissa, scale ≤ 28) | exact base 10 |
| String | `Rc<str>` | immutable, UTF-8; lengths count characters |
| Date | `chrono::NaiveDate` | |
| DateTime | UTC, whole seconds | |
| Duration | seconds (`i64`) | |
| Money | Decimal + currency code | three capital letters |
| Array, Map | shared, mutable (`Rc<RefCell<..>>`) | maps keep insertion order |
| BusinessReference | type + id | reading a field loads the object once per execution (read-only) |
| BusinessObject | shared, mutable; fields aligned with metadata | assignments are type-checked |
| PlatformCollection | rows of a document (view), a row | rows keep their document's lock |
| Function | user function or built-in | no closures |

Business objects have locks while their own handler runs (see [events.md](events.md)): they
cannot be saved, posted, reversed or deleted from inside, and outside BeforeCreate/BeforeSave
their fields cannot change. Data read through a reference is read-only; `load()` returns an
editable copy.

## Standard library

### Functions

| Function | Result |
| --- | --- |
| `str(x)` | text form (`12.50`, `2026-10-28`, `{a: 1}`, `GoodsReceipt GR-000001`) |
| `int(x)` | from Integer, whole Decimal, numeric String; otherwise VKS4012 |
| `decimal(x)` | from Integer, Decimal, Money amount, decimal String (no exponents) |
| `bool(x)` | from Boolean or exactly `"true"` / `"false"` |
| `round(x, places = 0, mode = "away")` | half away from zero, or `"even"` (banker's); Integer unchanged; Money rounds its amount |
| `abs(x)` | Integer, Decimal, Money, Duration |
| `min(a, b, ...)`, `max(a, b, ...)` | by the comparison rules |
| `date("2026-10-28")`, `date(y, m, d)`, `date(dateTime)` | Date |
| `dateTime("2026-10-28T14:30:00Z")`, `dateTime(date)` | any RFC 3339 offset, normalized to UTC |
| `now()`, `today()` | the execution's clock, fixed for the whole run |
| `days(n)`, `hours(n)`, `minutes(n)`, `seconds(n)` | Duration |
| `money(amount, "USD")` | Money |
| `format("{0} of {1}", a, b)` | `{{` and `}}` for literal braces |
| `typeOf(x)` | `"Decimal"`, `"Ref<Products>"`, `"GoodsReceipt"`, ... |
| `range(n)`, `range(a, b)` | Array of Integers; in `for` headers it does not build an array |
| `reject(message)` | stops with a business error (kind `rejected`), shown to users as is |
| `notify(message)`, `log(message)` | adds a log entry; `notify` entries of after-commit handlers become user notifications |

### Methods

| Receiver | Methods |
| --- | --- |
| String | `length() isEmpty() upper() lower() trim() contains(t) startsWith(t) endsWith(t) indexOf(t) substring(start, end?) replace(from, to) split(sep)` |
| Integer, Decimal, Money | `round(places?, mode?) abs()`; Money also has members `amount`, `currency` |
| Date | `year() month() day() dayOfWeek() addDays(n) addMonths(n) startOfMonth() endOfMonth()` |
| DateTime | `date() year() month() day() hour() minute() second()` |
| Duration | `totalSeconds() totalDays()` |
| Array | `count() isEmpty() add(v) insert(i, v) remove(i) contains(v) indexOf(v) join(sep?) slice(start, end?) first() last() sort() reverse() sum()` |
| Map | `count() isEmpty() has(k) get(k, default?) set(k, v) remove(k) keys() values()` |
| `Catalog.X` | `create(field: value, ...) findById(id) findByCode(code) findBy(field, value) list(field: value, ..., limit:, offset:)` |
| `Document.X` | `create(...) findById(id) findByNumber(number) list(...)` |
| `Register.X` | `increase(dimensions and measures by name)`, `decrease(...)` (Post handlers only), `balance(dimensions..., at: date?)` → Map of measures |
| Business object | `save() delete() post() reverse() ref() isNew()`; members: declared fields, rows, `id version deleted` (+ `number date status` for documents; `date` is assignable) |
| Reference | `load()`; member `id`; reading any field loads the object (read-only) |
| Rows | `add(field: value, ...) count() get(i) first() last() remove(i or row) clear() sum("field") isEmpty()`, indexing `rows[i]` |
| `Context` | members `user organization application operation correlationId`; `can("capability")` |

`find*` methods return the object or `null`. `post()` saves the document first, then posts it.

## Limits

Every execution carries limits (`vks-protocol::Limits`); the platform may set any of them and
the rest take these defaults:

| Limit | Default | Error |
| --- | --- | --- |
| steps (statements, loop iterations, calls) | 5,000,000 | VKS4200 |
| wall time inside the engine | 5,000 ms | VKS4201 |
| nested function calls | 128 | VKS4202 |
| elements in one collection, log entries, intents | 100,000 | VKS4203 |
| bytes in one string | 1,000,000 | VKS4204 |
| bytes allocated by script values (estimate, cumulative) | 64 MiB | VKS4205 |
| platform calls | 10,000 | VKS4206 |
| queries (find, list, balance) | 1,000 | VKS4207 |
| nested handler executions | 8 | VKS4208 |
| native stack used by the interpreter | 48 MiB of a 64 MiB thread | VKS4209 |

Outside the engine: the worker process runs under an operating-system memory limit (Windows
Job Object, Linux `RLIMIT_AS`; default 512 MiB) and the Java platform kills a worker that does
not answer within its wall-clock timeout (default 10 s). See [security.md](security.md).

## Error codes

| Range | Kind | Examples |
| --- | --- | --- |
| VKS1001–1007 | syntax (lexer) | unexpected character, unterminated string/comment, bad escape, script over 2 MB, non-ASCII identifier |
| VKS1101–1118, 1199 | syntax (parser) | expected token, unknown type, unknown event, statement starting with `{`, declaration inside a block, duplicate named argument, positional after named, duplicate map key, nesting too deep |
| VKS2001–2017 | metadata | see [metadata.md](metadata.md) |
| VKS3001–3020 | semantic | 3001 unknown name, 3002 duplicate `let`, 3003 assignment to undeclared, 3004 invalid target, 3005 break/continue outside loop, 3006 function name clash, 3007 duplicate parameter, 3008 arity/named arguments, 3009 handler target, 3010 unknown catalog/document/register, 3011 document event on a catalog, 3012 unknown field, 3013 duplicate handler, 3014 unknown method, 3015 register arguments, 3016 movement outside Post, 3017 platform-managed member, 3018 assigning a function or service, 3019 statements in an application, 3020 too many variables |
| VKS4001–4023 | type / runtime | 4001 operand types, 4002 non-Boolean condition, 4003 integer overflow, 4004 division by zero, 4005 decimal overflow, 4006 index out of range, 4007 index type, 4008 null access, 4009 no member, 4010 not callable, 4011 arguments, 4012 conversion, 4013 comparison, 4014 field type, 4015 read-only, 4016 currency mismatch, 4017 date arithmetic, 4018 register misuse, 4019 not saved yet, 4020 not iterable, 4021 required field, 4022 object state, 4023 no such entry point |
| VKS4100 | rejected | `reject(...)` or a rejection from a nested handler |
| VKS4200–4209 | limit | see Limits |
| VKS4300 | permission | missing capability |
| VKS4400–4404 | host | platform error, not found, validation, conflict, unsupported |
| VKS5001–5012 | platform (Java) | see [integration.md](integration.md#errors) |

## Status

Labels: **Tested** (implemented and covered by automated tests), **Implemented** (works, no
dedicated test), **Partial**, **Planned**, **Unsupported** (deliberately not offered).

| Area | Status | Evidence / notes |
| --- | --- | --- |
| Lexer, parser, AST, error recovery, positions | Tested | `vks-syntax/tests/syntax.rs` (13) |
| Metadata language, validation, registry, fingerprints | Tested | `vks-metadata/tests/metadata.rs` (7) |
| Migration planning with approval flags | Tested | metadata tests; Java `destructiveMigrationsNeedApproval` |
| Semantic analysis (scopes, arity, metadata-aware members) | Tested | `vks-runtime/tests/language.rs`, `business.rs` |
| Values, operators, exact decimals, checked integers | Tested | `language.rs` |
| Strings, dates, durations, money, arrays, maps | Tested | `language.rs` |
| Functions, recursion, named arguments, function values | Tested | `language.rs` |
| Execution limits (steps, time, depth, size, memory) | Tested | `language.rs` `limits_stop_runaway_scripts`, `fuzz.rs` |
| Catalog and document objects, rows, references | Tested | `business.rs`, Java `InventoryDemoTest` |
| Event handlers (Before*, Post, After* via outbox) | Tested | `business.rs`, `InventoryDemoTest` |
| Accumulation register movements and balances (current, historical) | Tested | `business.rs`, `InventoryDemoTest` |
| Reversal and reposting | Tested | `business.rs`, `InventoryDemoTest` |
| Capability checks (engine and platform) | Tested | `business.rs`, `InventoryDemoTest`, `scriptsActWithTheCallersPermissions` |
| `vks/1` worker protocol, nested executions | Tested | `vks-cli/tests/worker.rs` (4) |
| Worker timeout kill and replacement | Tested | Java `WorkerTimeoutTest` |
| Worker OS memory limit (Windows Job Object, Linux RLIMIT_AS) | Implemented | applied at worker start; not exercised by a test |
| Randomized robustness (no panics on arbitrary input) | Tested | `fuzz.rs` (stable-Rust generators, not coverage-guided) |
| CLI: check, metadata, plan, run, worker, bench | Implemented | worker covered by tests; others used manually |
| In-memory platform for tests and `vks run` | Tested | `business.rs`; development only |
| Java platform: deploy, migrate, CRUD, post, reverse, balances, audit, outbox | Tested | `InventoryDemoTest` (real PostgreSQL) |
| Optimistic concurrency, duplicate-post prevention under concurrency | Tested | `InventoryDemoTest` |
| Information registers (declaration, storage) | Partial | declared and migrated; no script writes (`increase` refused) and no balance semantics |
| Accounting entries (`Intent::AccountingEntry`) | Partial | protocol type exists; no script API; platform answers 501 |
| `Money` as a metadata field type | Planned | runtime Money exists |
| Periodic information registers, slice-last queries | Planned | |
| Query language beyond find/list/balance | Planned | no ad-hoc queries; never raw SQL |
| Idempotency keys on the REST API | Planned | duplicate posting is prevented by state and constraints |
| Monaco authoring and publication | Tested | Studio runs real worker diagnostics, reviews migrations and publishes guarded revisions. [Editor workflow](editor.md) |
| Language server (LSP) | Planned | the diagnostics and metadata APIs provide inputs for future language tooling |
| Coverage-guided fuzzing (`cargo fuzz`) | Planned | needs nightly Rust |
| User-defined classes, inheritance, reflection, eval, FFI, file/network access | Unsupported | by design |
