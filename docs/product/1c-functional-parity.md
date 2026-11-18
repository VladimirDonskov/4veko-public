# 1C ecosystem functional coverage

Use the [capability matrix](ecosystem-capabilities.csv) to find a 4VEKO feature, its prerequisite, priority, implementation boundary, comparison source, acceptance evidence and next engineering action. It covers the ERP, the extension platform and the applications that rely on them. The domain letters A–R follow the product brief. A row describes one independently checkable outcome. Dependencies refer to module owners in the [dependency map](module-dependency-map.md).

The snapshot includes the local changes on top of `980c832`. Its ERP evidence comes from Fastify routes, Drizzle constraints and the Next.js application. The TypeScript configuration runtime can use ERP posting APIs. The Java platform and its Rust worker own a separate application store. A real Studio browser session exercised checking and publishing source through the gateway, handling a stale draft and limiting a viewer to published metadata. See the [architecture decision](../vekoscript/adr/0002-java-platform-scope.md) and the [engineering checkpoint](implementation-progress.md).

## Reading the matrix

| Status | Evidence required |
| --- | --- |
| NOT STARTED | Requested business outcome has no identified implementation or approved executable specification in the inspected paths. |
| RESEARCHED | A public comparison and a scoped use case exist. |
| DESIGNED | A concrete technical contract or design exists. Delivery and acceptance are pending. |
| IMPLEMENTED | A named execution path or component exists. Its limitations column states its boundary. |
| TESTED | The stated scenario passed on the recorded build. See the test identifier and linked run record. A narrower row can pass while the complete domain remains open. |
| PRODUCTION-VALIDATED | Operational evidence exists for the version, tenant scope, reviewed financial rules, restore procedure and deployment under consideration. |
| BLOCKED | An identified external dependency prevents execution of the stated acceptance scenario. |

P0 covers financial integrity, tenant isolation, posting or a dependency that blocks them. P1 unlocks an ordinary business workflow. P2 extends depth, specialization or channels. Priorities indicate sequence. Use the [acceptance criteria](../testing/ecosystem-acceptance-criteria.md) to track verified work. The [Replica inventory](../../replica/features.csv) and its historical score use a smaller feature list and different weights.

## Evidence index

| Key | Location and scope |
| --- | --- |
| OTC | [Sales and receivables API regressions](../../apps/api/test/order-to-cash.test.ts) and the [sales browser journey](../../apps/web/e2e/order-to-cash.spec.ts) |
| PTP | [Procurement and payables API regressions](../../apps/api/test/purchasing.test.ts) and the [purchase browser journey](../../apps/web/e2e/procure-to-pay.spec.ts) |
| CLOSE | [Dated aging and control reconciliation](../../apps/api/test/historical-aging.test.ts), [month-end browser journey](../../apps/web/e2e/period-close.spec.ts) and [recorded outcomes](implementation-progress.md) |
| DETAIL | [Account-ledger API detail and cutoff tests](../../apps/api/test/account-ledger.test.ts). A 5,001-line period includes complete balances beyond one line's precision limit for both debit- and credit-normal accounts. |
| RESTORE | [Local PostgreSQL restoration run](implementation-progress.md) covering 1,110 invoices, 2,319 entries and 9,067 journal lines. The post-sealing run matched 38 table and sequence fingerprints. |
| LOCK | [Concurrent close, reopening and zero-value inventory controls](../../apps/api/test/period-close.test.ts). See GL and MIG for journal membership sealing and upgrade from populated 0004 data. |
| GL | [Ledger and database constraints](../../apps/api/test/ledger.test.ts) |
| SEC | [Session, authorization and tenant boundaries](../../apps/api/test/security.test.ts) |
| MIG | [Drizzle migrations](../../apps/api/test/migrations.test.ts) |
| DEC | [Decimal arithmetic and document totals](../../apps/api/test/money.test.ts) |
| CFG | [TypeScript application configuration](../../apps/api/test/configuration.test.ts) |
| ENG | [Rust language](../../engine/vekoscript/crates/vks-runtime/tests/language.rs), [business objects](../../engine/vekoscript/crates/vks-runtime/tests/business.rs), [metadata](../../engine/vekoscript/crates/vks-metadata/tests/metadata.rs) and [worker protocol](../../engine/vekoscript/crates/vks-cli/tests/worker.rs) |
| JVM | [Java application lifecycle, isolation and posting](../../backend/src/test/java/com/fourveko/platform/InventoryDemoTest.java) and [worker timeout](../../backend/src/test/java/com/fourveko/platform/WorkerTimeoutTest.java) |
| UPG | [Populated schema upgrade, rollback and uniqueness](../../backend/src/test/java/com/fourveko/platform/CatalogSchemaUpgradeTest.java) |
| GW | [Gateway tests with a substitute upstream](../../apps/api/test/platform.test.ts) and [Java configurator API tests](../../backend/src/test/java/com/fourveko/platform/ConfiguratorApiTest.java) |
| STUDIO | [Live Studio browser acceptance](../../apps/web/e2e-platform/studio.spec.ts). The browser, Fastify gateway, Java service, Rust worker and PostgreSQL exercise the application publishing path. |
| UI | [ERP navigation and tables](../../apps/web/src/components), [browser specifications](../../apps/web/e2e) and [design system](../design/design-system.md) |

## Public comparison sources

A reference identifies the comparable product area. Fine-grained acceptance conditions in the matrix are original 4VEKO requirements, including the requirements for US localizations. The references establish neither behavioral equivalence nor regulatory approval. Further historical 1C references are recorded in the [existing public research](../research/competitor-analysis.md).

| Key | Comparable area and publisher |
| --- | --- |
| ERP | Sales, purchasing, stock and financial planning. [1Ci ERP](https://www.1ci.com/applications/1c-erp/) |
| LOW | Metadata-driven business applications and reusable customizations. [1Ci developer platform](https://www.1ci.com/developers/) |
| MFG | Product engineering, planning, scheduling and production control. [1Ci production subsystem](https://www.1ci.com/applications/1c-erp-production-subsystem/) |
| BC | Finance, sales, purchasing, warehousing, projects and resources. [Microsoft Business Central](https://learn.microsoft.com/en-us/dynamics365/business-central/across-business-functionality) |
| BANK | Comparing recorded cash activity to a statement and resolving the difference before completion. [Intuit reconciliation workflow](https://quickbooks.intuit.com/learn-support/en-us/help-article/statement-reconciliation/reconcile-account-quickbooks-online/L3XzsllsK_US_en_US) |
| GROUP | Subsidiaries, currencies and consolidated reporting. [Oracle NetSuite OneWorld](https://www.netsuite.com/portal/assets/public-pdf/ds-netsuite-oneworld.pdf) |
| BI | Analytics alongside finance, inventory and customer data. [SAP Business One](https://www.sap.com/products/erp/business-one.html) |
| CRM | Lead conversion and pipeline review. [Odoo lead conversion](https://www.odoo.com/documentation/19.0/applications/sales/crm/acquire_leads/convert.html) |
| HR | Payroll inputs, contracts and payslips. [Odoo Payroll](https://www.odoo.com/documentation/19.0/applications/hr/payroll.html) |
| DOC | File lifecycle and organization. [Odoo Documents](https://www.odoo.com/app/documents-features) |
| SERVICE | Project work, time and customer support. [Odoo Services](https://www.odoo.com/documentation/19.0/applications/services.html) |
| POS | Till operations and retail sales. [Odoo Point of Sale](https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/use.html) |
| ASSET | Equipment and related work orders. [Microsoft asset management](https://learn.microsoft.com/en-us/dynamics365/supply-chain/asset-management/overview/objects-and-work-orders) |
| TMS | Carrier selection, load planning, charges and inbound/outbound routes. [Microsoft transportation management](https://learn.microsoft.com/en-us/dynamics365/supply-chain/transportation/transportation-management-overview) |
| FLOW | Triggers, conditions and actions. [Odoo automation rules](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html) |
| API | Authorization and external accounting integration. [Intuit developer platform](https://developer.intuit.com/app/developer/qbo/docs/) |
| TAX | Transaction records for a specialized tax provider. [Stripe Tax API](https://docs.stripe.com/api/tax/transactions/object) |
| EXT | Environment-scoped app installation and upgrades. [Microsoft application management](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/administration-center-api_app_management) |
| VERT | Industry application packaging. [Odoo industry catalog](https://www.odoo.com/all-industries) |

## Evidence boundaries to retain

- Sales supports single-order invoicing, payments, an unapplied credit balance and voiding an unpaid invoice. Shipment management, credit memos, returns and disbursement of a refund each require their own document and posting evidence.
- Procurement supports stock receipt, matching a bill to received quantities, price variance, expense bills and paying vendors. Supplier selection, requisition approval and physical returns require separate workflows.
- An organization is the current ERP tenant. Group reporting requires explicit legal-entity rights, mappings and eliminations. Operating several separate organizations does not establish this capability.
- A customer exemption flag and one organization sales-tax rate implement a limited calculation. Rate sourcing, dated rules, certificate lifecycle and external validation remain distinct work.
- A VekoScript stock register records application-defined movements. Migrating inventory ownership requires a verified bridge to the ERP stock and General Ledger transaction boundary. Counts across both runtimes must include each business effect once.
