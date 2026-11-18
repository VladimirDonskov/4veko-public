# Platform architecture

The running system has two transaction owners. Fastify owns the Release 0.1/0.2 ERP books. Spring owns each deployed VekoScript application's objects and registers. The boundary matters when a workflow moves money or stock. A successful Java register posting, by itself, makes no entry in the ERP General Ledger. [Transition decision](../vekoscript/adr/0002-java-platform-scope.md)

| Entry point | Authority and persistence | Current use |
| --- | --- | --- |
| Next.js pages under `apps/web/src/app` | React components call the API using the current browser session | ERP documents and reports. The existing Configurator and `/x` pages address the TypeScript configuration runtime. |
| Fastify under `apps/api` | Session membership selects the organization. Drizzle migrations own the ERP schema. The posting service and database constraints govern accounting writes. | Customer and supplier records, orders, receipts, invoices, bills, payments, stock and journals. |
| Fastify configuration routes | The TypeScript parser, checker and interpreter in `apps/api/src/lang` serve stored configurations. | Existing configurations and dynamic screens remain consumers of this API. |
| Fastify platform gateway and Next.js `/studio` | The API maps membership to a platform role, signs a short-lived token and calls Spring. Browser clients retain the cookie session. | Studio lists tenant applications, checks and publishes versioned source, and displays published metadata to readers. The gateway and Java service require a matching secret. |
| Spring `/api/v1/apps` under `backend` | Organization and application select a schema. Flyway owns service tables. Versioned application metadata generates catalog, document, row and register tables. | Per-application source, migration plans, versions, object CRUD, posting, reversal, balances and event delivery. |
| Rust workspace in `engine/vekoscript` | Spring leases a worker and services typed host requests within the active transaction. | Source diagnostics, metadata checks, migration planning and bounded script execution. |

## Ownership and consistency

ERP modules resolve customers, vendors, items, system accounts and financial periods in the ERP database. Invoice and receipt posting write source-document changes, inventory, ledger and audit in a single transaction. The platform example declares its own products and warehouses inside an application schema. Linking a platform reference to an ERP master record requires a supported, tenant-scoped identity contract. Reusing a product name or copying a UUID between stores would give misleading reconciliation results. [ERP data model](data-model.md)

Keep new financial effects behind the existing posting authority until a replacement passes the same behavioral tests. A cross-service event needs a durable source ID, organization, version, retry identity and reconciliation query. An outbox can signal a committed change, but sending two HTTP requests does not provide atomic posting.

## Deployment and recovery

The root Compose file starts PostgreSQL and optionally Fastify and Next.js. Spring and the compiled worker require separate provisioning. The Java service uses a dedicated database and the configured worker binary. Database versions for ERP, platform infrastructure and individual applications have separate migration histories. The VekoScript CI workflow builds a release worker and runs the Java suite with PostgreSQL. [Local platform setup](../../backend/README.md) · [CI workflow](../../.github/workflows/vekoscript.yml)

Platform deployment stores the source, metadata, handler list, plan and executed DDL. PostgreSQL can roll back a failed deployment transaction. Restoring an older source can generate further DDL and cannot recover data discarded by a committed destructive step. Before supporting unattended upgrades, exercise backups, an isolated restore and reconciliation of record and movement counts.

Flyway V2 aligns catalog uniqueness indexes with active application metadata. It uses stored DDL and the current PostgreSQL index definition to identify indexes created by older platform releases. If an intended constraint is missing and existing active records conflict, the entire migration rolls back. Resolve the duplicate records using the application's business rules before retrying. The upgrade test covers preservation of a manually changed index, rollback and retry with populated tables. [Catalog schema upgrade test](../../backend/src/test/java/com/fourveko/platform/CatalogSchemaUpgradeTest.java)

## Boundaries for the next increments

1. Extend Studio's source workflow with generated list/detail views for published applications. Keep existing TypeScript configurations readable across the transition. [Studio authoring and verification](../vekoscript/editor.md)
2. Introduce a tenant-scoped ERP master-data contract before exposing financial commands to scripts. Verify the source document, stock, journal, period lock, audit and repeated delivery together.
3. Add application/package compatibility checks and installation grants before accepting third-party code. Test an upgrade against populated data, with in-flight work and queued older-version events.
4. Qualify packaging and operations for the actual environments. Record restore objectives, secrets rotation, capacity limits and access-controlled diagnostics from a deployment rehearsal.

Successful local tests provide evidence for the exercised workflows. Multi-site recovery, production isolation and regulatory review have separate acceptance gates.
