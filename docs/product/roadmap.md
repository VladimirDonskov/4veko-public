# Roadmap

For the current checkout, follow the [engineering checkpoint](implementation-progress.md),
[ecosystem roadmap](full-ecosystem-roadmap.md) and [capability matrix](1c-functional-parity.md).
The October checkpoints below describe the original release scope.

Status labels: **Tested** (built, with automated tests), **Implemented** (built, checked by hand
only), **Planned** (designed or scoped, not built), **Research only** (studied, no decision yet).

## Release 0.1 — foundation (this checkpoint, 2026-10-28)

| Capability | Status |
| --- | --- |
| Signup, organizations, sessions, sign-out | Tested |
| Roles (owner, admin, accountant, sales, viewer) and member management | Tested |
| Customers, vendors (bulk archive, search, balances) | Tested |
| Products and services (stocked, non-stocked, service) | Tested |
| Chart of Accounts (US template, system accounts, ledger per account) | Tested |
| General Ledger: manual entries, reversal, immutability, period lock | Tested |
| Sales orders → invoices (one click), void with reversal | Tested |
| Customer payments: application, credits, idempotency | Tested |
| Inventory: moving average, adjustments, movement history | Tested |
| Reports: trial balance, P&L, balance sheet, AR aging; CSV and print | Tested (API); UI via e2e for TB, BS, aging |
| Dashboard KPIs, revenue chart, aging, low stock, activity | Tested (values reconciled in API tests; UI in e2e) |
| Audit log (append-only) | Tested |
| Global search and command palette | Implemented (search API tested; palette checked by hand) |
| Saved table views, bulk actions, keyboard table navigation | Implemented |
| Light and dark themes, responsive layout | Tested (contrast check; phone-width e2e) |
| OpenAPI document and UI at `/api/docs` | Implemented |
| Docker images, Compose, CI workflow | Implemented (images built and smoke-tested locally; CI not yet run on GitHub) |

## Release 0.2 — complete the small-business loop (in progress)

1. **Procure to pay — Tested (2026-10-28):**

   | Capability | Status |
   | --- | --- |
   | Purchase orders (draft → issued → partially received → received / closed / cancelled), stocked items only | Tested |
   | Receiving into stock at order cost: Dr Inventory / Cr Received Not Billed | Tested |
   | Vendor bills from received order lines (three-way match: never bill more than received, enforced in the database) | Tested |
   | Purchase price variance when the bill cost differs from the order cost | Tested |
   | Expense bills (rent, utilities, services, equipment) | Tested |
   | Duplicate vendor invoice numbers refused per vendor (database unique index) | Tested |
   | Bill payments from a bank account, several bills at once, idempotent retries | Tested |
   | Void unpaid bills (reversal; order lines become billable again) | Tested |
   | AP aging report, vendor balances and activity, dashboard payables tile, search | Tested |
   | Receipt reversal (returning goods to the vendor), vendor credits, partial-payment discounts | Planned |

2. **Banking.** CSV statement import and one-to-one matching against posted bank lines are implemented. A grouped deposit moves whole customer receipts from Undeposited Funds into the bank in one journal. The deposit can be traced from each receipt through the posted journal to its statement match. OFX and provider feeds remain separate integrations.
3. **Sales depth:** quotes/estimates, partial invoicing, credit notes and refunds, invoice PDF and email.
4. **Account lifecycle:** email invitations, verification, password reset, MFA.
5. **Organization time zone** and fiscal-period management (period list instead of a single lock date).
6. **Imports:** CSV import with dry run for customers, vendors, items, opening balances.

## Release 0.3 — platform

Custom fields on customers, vendors, items and documents; approval rules (e.g. bills over a
threshold); API keys with scopes; signed outbound webhooks; Postgres row-level security as a
second isolation layer; multiple warehouses and transfers in the UI; server-side saved views.

## Later (planned, order to be set by customer research)

US sales tax engine integration (no in-house compliance claims); multi-currency; multiple
companies per tenant with intercompany and consolidation; fixed assets and depreciation;
budgets and plan vs actual; FIFO lots and serial numbers; simple BOMs and assembly; CRM
pipeline; projects and job costing; HR records; payroll through a US payroll provider; document
attachments; BI report builder.

**AI assistant (planned):** explain reports, find records, draft documents, flag unusual entries
and suggest categories, using only data the user may see, through the same permissioned API,
with explicit confirmation before any posting or payment and an audit record of every action.

## Research only

Manufacturing scheduling/MES (1C:ERP depth, S2); holding consolidation with IFRS mapping (S9);
offline mobile apps (S14). Competitor user sentiment: only 9 developer comments collected;
end-user reviews still to be gathered by hand (review sites block automated reading).

## Current handoff

The [engineering checkpoint](implementation-progress.md) tracks the verified release, working
changes and remaining gates. The next core increment is **customer credit memos and partial returns**.
Start with an original posted invoice, select the returned quantities and retain the original
prices, tax and stock cost. Reconcile the credit with AR and the unaffected sale lines.
See the [release sequence](full-ecosystem-roadmap.md#near-term-engineering-order).
