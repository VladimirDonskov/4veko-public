# VekoScript application and extension model

A deployable application currently consists of VekoScript source. Its declarations describe catalogs, documents with line collections, references and registers. Its functions and lifecycle handlers execute in a Rust worker. Spring validates the caller, owns storage and commits the result. The inventory receiving example exercises this path with a real PostgreSQL database. [Inventory example](../../engine/vekoscript/examples/inventory.vks) · [API integration test](../../backend/src/test/java/com/fourveko/platform/InventoryDemoTest.java)

## Existing development contract

| Developer operation | Runtime behavior | Scope |
| --- | --- | --- |
| Check source | Parser and analyzer return positioned diagnostics, metadata and handler declarations. | Syntax, field definitions, references and supported host calls. |
| Review and publish source | An administrator previews the proposed source against a numbered base revision in Studio. The service rechecks the base revision under a database lock and recomputes the plan during publication. | A stale Studio submission conflicts. Older API clients can omit the revision precondition. Risky steps need explicit approval. A database constraint failure rolls back the version and DDL together. |
| Save a catalog or document | The service checks capability, validates fields and references, runs applicable handlers and writes audit. A stale object version conflicts. | Generated storage supports declared fields and line collections. |
| Post or reverse | Document status is checked under a row lock. The posting handler emits typed intents. The host validates and persists accumulation movements. Reversal retains inactive movements for inspection. | ERP financial posting and accounting-register handlers need additional integration. |
| Deliver after-commit work | Each queued event captures its application revision, actor, capabilities and object payload. The dispatcher leases a row and delivers the handler in a separate transaction. | Failed deliveries have a bounded retry count. Old handler code can encounter a newer physical schema following deployment. |
| Diagnose execution | The worker protocol carries operation context and structured errors. Script and wall-clock limits bound execution. | OS memory enforcement is platform-specific. A local timeout test confirms worker replacement. |

The public HTTP routes use `/api/v1`. The internal Java/worker protocol uses `vks/1`. A numbered source revision identifies one application deployment. These identifiers version different interfaces. Compatibility across a worker upgrade needs fixtures for wire values, host calls, source execution and stored application schemas. [Protocol ADR](../vekoscript/adr/0001-json-lines-protocol.md) · [Language semantics](../vekoscript/specification.md)

The default capabilities cover catalog and document reads and writes, posting and register reads. Lifecycle handlers inherit the caller's permissions. Script functions can call host operations for objects and balances. They have no general file, SQL or network interface. Function-local computations can use decimals, dates, durations, money and collections. Money-valued metadata fields, general database queries, information-register writes, scheduled application scripts and per-record authorization remain open. [Runtime evidence](../vekoscript/runtime.md) · [Security model](../vekoscript/security.md)

## Package installation design

Third-party installation still needs the following contracts. They specify the evidence required before publishing a package.

| Contract | Required behavior | Acceptance example |
| --- | --- | --- |
| Manifest and artifact | Bind a stable package ID, publisher, immutable version, content digest, entry point, required platform API, dependency ranges and requested capabilities. Verify the publisher and artifact before executing source. | An altered file, unsupported API or conflicting dependency is rejected before storage changes. |
| Tenant installation | Store the resolved dependency versions and administrator-approved grants per organization. Compute effective host capabilities as the intersection of caller rights and installation grants. | A document writer with a read-only package installation cannot cause a script write. Another tenant's installation remains independent. |
| Upgrade and rollback | Check the installed revision, test the migration on representative data, review risky changes and serialize installation against concurrent upgrades. Preserve staged and active versions. | Two concurrent requests for one version produce one installation. Failure leaves the prior version, records and grants accessible. |
| Events and host APIs | Publish versioned host operations and event schemas. Record delivery identity and application version. Provide compatibility or drain pending work before incompatible DDL. | A queued event created on the previous revision is processed once with its original business effect or is held with an actionable reason. |
| External connectors | Expose narrow server-side operations with tenant-scoped credentials, audit and retry identities. Return explicit provider and authorization errors. | The same retry identity creates only one external business effect in a provider sandbox. The worker never receives a provider secret. |

An application source deployed by an administrator exercises the existing runtime. Marketplace discovery, publisher verification, dependency resolution and package-level grants need their own implementation and acceptance evidence.
