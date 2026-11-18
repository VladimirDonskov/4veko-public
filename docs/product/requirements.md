# Product requirements

Product: **4VEKO** (working name), an English-first business management platform for US
small and mid-size businesses. First release: a reliable accounting, sales and inventory core
that later modules build on. Feature evidence and priorities: `docs/research/feature-matrix.md`.

## Target users

| Persona | Needs |
| --- | --- |
| Owner / founder (5–100 employees) | Know cash, sales and what is owed; get invoices out; trust the numbers |
| Bookkeeper / accountant (in-house or outside) | Correct double-entry books, period close, audit trail, standard reports |
| Sales / operations | Customers, orders, invoices and stock without accounting knowledge |
| Viewer (investor, advisor) | Read-only access to reports |

## Functional requirements — first release (status: implemented and tested)

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-1 | Self-serve signup creates a working company | One form → user, organization, owner role, 33-account US chart, default warehouse, in one transaction |
| FR-2 | Roles and permissions | owner, admin, accountant, sales, viewer; server-enforced; last owner protected; removal revokes sessions |
| FR-3 | Customers and vendors | create, edit, archive in bulk, search; customer balance = open invoices − credits |
| FR-4 | Products and services | stocked, non-stocked, service; default accounts by type; SKU unique; type locked after stock moves |
| FR-5 | Chart of Accounts | create, rename, archive; type locked after postings; system accounts protected; live balances |
| FR-6 | General Ledger | balanced, immutable entries; reversal only; period lock; ledger per account with running balance |
| FR-7 | Sales orders | draft → confirmed → invoiced / cancelled; server-computed totals with discount and sales tax |
| FR-8 | Invoices | one-click from an order or standalone; posts AR, revenue, tax, COGS and stock atomically; void with reversal |
| FR-9 | Customer payments | apply to invoices (oldest first by default); overpayment kept as credit; idempotent retries |
| FR-10 | Inventory | moving-average cost; adjustments in and out; no negative stock; history per item |
| FR-11 | Dashboard | revenue MTD/YTD, net income, cash, AR, overdue, inventory value, open orders, 6-month revenue, aging, top customers, low stock, activity |
| FR-12 | Audit history | append-only log of critical actions with actor, time, IP |
| FR-13 | Reports | trial balance, P&L, balance sheet, AR aging; CSV export and print |
| FR-14 | Global search and command palette | Ctrl/⌘ K finds customers, items, documents, accounts and runs common actions |
| FR-15 | API | REST under `/api/v1`, OpenAPI document and UI at `/api/docs` |

## Functional requirements — Release 0.2 procure to pay (status: implemented and tested)

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-16 | Purchase orders | stocked items; draft editable; issue, cancel (draft/issued), close (partially received); server-computed totals |
| FR-17 | Receiving | partial or full; never more than ordered (also under concurrent requests); stock in at order cost; Dr Inventory / Cr Received Not Billed |
| FR-18 | Vendor bills | from received lines (never more than received) and/or expense lines; price variance to its own account; duplicate vendor invoice numbers refused; void unpaid bills |
| FR-19 | Bill payments and payables | pay several bills from a bank account; no over-payment; idempotent retries; AP aging; vendor balance equals aging; AP control account reconciles |

## Release 0.2 banking

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-20 | Reconcile a bank statement | An accountant imports the statement with stable line references, matches each bank transaction to one ledger line, explains outstanding items and closes a balanced period. Replaying the same import adds zero rows. An owner or admin can reopen a closed statement with an audit trail. |
| FR-21 | Group customer receipts into a bank deposit | Post a selection of whole Undeposited Funds receipts into an active bank account. Retain the breakdown and original applications, prevent duplicate claims on retry or concurrent submission, and clear the deposit as one bank line. A dated reversal releases the receipts for a replacement deposit after any bank match has been removed. |

The [B01–B05 acceptance gates](../testing/ecosystem-acceptance-criteria.md#bank-statement-reconciliation) describe the opening-balance assumption and the controls across consecutive statements.
The [deposit acceptance gates](../testing/ecosystem-acceptance-criteria.md#grouped-bank-deposits) cover receipt eligibility, posting, correction and tracing.

## Non-functional requirements

| ID | Requirement | Target | Status |
| --- | --- | --- | --- |
| NFR-1 | Money correctness | no floating point in posting; reconciliation invariants hold | met (tests + DB triggers) |
| NFR-2 | Tenant isolation | no cross-org read, write or reference | met for tested paths; RLS planned |
| NFR-3 | Latency | p95 < 150 ms for reads and postings at 1,000+ invoices on a developer laptop | met (`docs/testing/benchmark-results.md`) |
| NFR-4 | Accessibility | WCAG 2.2 AA | automated axe: 0 violations on 8 screens; manual audit pending |
| NFR-5 | Responsive | usable at 390 px, no horizontal page scroll | met on 5 key screens (Playwright) |
| NFR-6 | Deployability | Docker images, migrations on start, health check, env config | met locally; no production deploy |

## Differentiators and measurable acceptance criteria

We will not claim superiority over 1C without a comparable, lawfully licensed benchmark
environment, which we do not have. The criteria below measure 4VEKO against its own targets.

| Differentiator | Measure | Target | Current (measured) |
| --- | --- | --- | --- |
| A. Faster workflows | UI actions from "new order" to posted invoice (existing customer and item) | ≤ 5 | 4: choose customer, choose item, enter quantity, "Save and invoice" (Playwright flow) |
| A. Faster workflows | Actions to record a full payment from an invoice | ≤ 3 | 2: "Record payment" (amount and invoice pre-filled), "Record payment" |
| A. Faster workflows | Time to first posted invoice for a new company | ≤ 10 min for a new user | not measured with real users |
| B. Customization | Custom fields without code | planned | not built |
| C. Integrations | Every UI action available via documented API | 100% of routes in OpenAPI | met: the UI uses only the public `/api/v1` |
| D. AI assistance | Answers grounded in permitted data, no unconfirmed postings | planned | not built |
| E. Onboarding | Working company immediately after signup | chart, warehouse, onboarding checklist, demo data script | met |
| F. Reliability | Ledger invariants hold under concurrency and retries | 0 double postings in race tests | met (concurrent invoice, payment and idempotency tests) |
