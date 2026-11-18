# Module dependencies and transaction ownership

The installed ERP and the application platform have separate data owners. A reference in this table names a logical capability, so a dependency can be satisfied within the current process and database. Each row includes the observation that makes the dependency necessary.

## Executable boundaries

| Owner | Current authority | Contract for consumers |
| --- | --- | --- |
| Fastify identity | Sessions, memberships, organizations, roles | Resolve the organization and role from an authenticated request. Recheck ownership on references supplied in that request. |
| Fastify master data | ERP parties, items, chart, locations and organization settings | Sales, purchasing and inventory reference the same organization-scoped IDs. Services use the permitted item and account types. |
| Fastify ERP posting | Journal headers/lines, immutable posted entries and linked reversals | Business services call the shared posting operation inside the transaction holding their state and stock locks. Use fixed-point amounts and preserve document/date/source references. |
| Fastify inventory | Stock levels and stock movements by item and location | Sales and purchasing consume the same movement and costing functions. The movement links to its originating document and journal. |
| Fastify TypeScript configuration | Saved configuration source, configured objects, registers and handlers | Existing configuration handlers call the ERP host inside the transaction. Migration requires replay of configuration regression fixtures and preservation of existing data and behavior. |
| Java application platform | Tenant/application metadata, versions, generated business objects, register movements, application audit and event outbox | Java validates a scoped caller, applies metadata, runs a bounded worker and commits validated intents. Its register data resides in platform-owned PostgreSQL storage. |
| Rust VekoScript worker | Parse, check and execute scripts behind the worker protocol | Host calls carry typed operations. Java resolves capabilities and authorizes data access. Timeout and rollback travel through the host transaction. |
| Next.js client | Data entry, navigation, form validation feedback and reports | Numeric posting and inventory authority belong to the server. Preserve the reporting business date across API request, display and export. |

The current ERP sign-in and the working-tree gateway can supply a scoped caller to the Java API. A gateway request crosses an HTTP and storage boundary. An ERP transaction cannot roll back a separate committed Java transaction. For future ledger-writing extensions, either execute all authoritative effects inside the same database transaction at their owner or send one durable posting request to a single posting owner and surface its pending state until it commits. Store a stable intent identity there and reconcile outcomes across retries. The application upgrade contract needs an explicit choice before exposure to customer extensions. [Platform architecture](../architecture/platform-architecture.md) · [VekoScript decision](../vekoscript/adr/0002-java-platform-scope.md)

## Business dependencies

| Consumer | Prerequisite owner or capability | Acceptance condition at the boundary |
| --- | --- | --- |
| A · Finance | Identity, chart, periods, ledger and source document | Every posted effect has a tenant, balancing lines and a traceable source. Closing a period protects all callers. |
| B · Sales | Parties, items, tax, inventory, receivables and ledger | A posted invoice changes receivables, tax, stock and COGS together. Credits and receipts refer to the original invoice. |
| C · Procurement | Parties, items, inventory, payables and ledger | Receiving accrues the liability. Billing clears the accrual up to received quantity. Payments reduce the same liability. |
| D · Inventory | Items, location ownership, costing and ledger | Receipts and issues preserve dated quantity and value. Transferring stock between sites preserves total holdings. |
| E · Manufacturing | Versioned BOMs, routings, inventory, labor and WIP accounts | Consumption, scrap and finished output explain remaining WIP by production order. |
| F · CRM | Parties, activities, permissions and sales order conversion | A won opportunity reuses its existing customer identity and preserves the sales source. |
| G · People | Identity, employees, restricted documents, periods and finance | Authorized reviewers approve effective-dated inputs. An immutable payroll run produces at most one posting identity. |
| H · Documents | Identity, tenant-scoped blob references, metadata and retention | Revocation affects list, preview and download. Audit identifies the file revision used for approval or signature. |
| I · Projects | Parties, approved time, procurement, billing and dimensions | Project cost and billed amounts drill down to the originating hours, bills and journals. |
| J · Retail | Items, pricing, inventory, tax, cash clearing and payment adapters | A completed sale or refund has a stable till/transaction ID. Offline replay reconciles each tender and stock movement. |
| K · Assets | Equipment master, finance asset link, inventory and time | A maintenance work order receives only its authorized parts and labor. Financial depreciation stays with Finance. |
| L · Logistics | Fulfillment documents, carriers, inventory and procurement | Every load item has an originating delivery or receipt. Freight settlement reconciles to approved carrier charges. |
| M · Corporate | Legal-entity identities, entity ledgers, rates and account mapping | Group entries and eliminations are traceable. Group rights never grant implicit access to an unrelated tenant. |
| N · Analytics | Permission-filtered domain facts, source IDs, dates and dimensions | A derived total reconciles to the same source period and authorization scope as its drill-down. |
| O · Flow | Business events, actor/capabilities, scheduled execution and outbox | Retried processing has a durable outcome. A task approves a specific revision under the current approver's rights. |
| P · Connect | Identity, versioned contracts, protected provider credentials and durable delivery IDs | Import retries preserve a single business effect. A vendor callback can be tied to its tenant and document. |
| Q · Marketplace | Signed packages, runtime contracts, release reviews, migrations and tenant consent | Resolver rejects incompatible or unreviewed artifacts before applying schema or business changes. |
| R · Industry applications | Marketplace or approved package installs, Studio and proven shared services | Each vertical adds industry-specific rules, screens and reports while continuing to consume shared ERP posts and master data. |

## Sequence before widening a contract

1. **Fact ownership.** Name the system of record and stable ID. Reserve separate fields for tenant, legal entity, business date, recorded timestamp and actor wherever their meanings differ.
2. **Atomicity.** Define which changes must commit together. Give asynchronous work an explicit pending state, retry identity, acceptance/failure result and a reconciliation query.
3. **Data evolution.** Run the previous-version data fixture with the new code, rehearse compatible migrations and test failures before switching readers.
4. **Access.** Exercise reads, writes, relationships, exports, historical views and after-commit work under two independent tenants.
5. **Release.** Record the named end-to-end business scenario and its saved/posted/reversed totals in the [checkpoint](implementation-progress.md). Use those results when promoting the related [matrix rows](ecosystem-capabilities.csv).
