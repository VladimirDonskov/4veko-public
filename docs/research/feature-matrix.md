# Competitive feature matrix

Evidence labels: **V** verified on the cited page (see source IDs S1-S21 in
`competitor-analysis.md`), **I** inferred or general ERP knowledge, **P**
proposed by us. Priority: **must** (MVP / first release), **should** (next
two releases), **could** (later), **skip** (out of scope, with reason).

Machine-readable version for `replica-diff`: `replica/features.csv`.

## A. MVP features (detailed)

### A1. Sign up and create an organization
- **Problem:** a business needs its own isolated workspace before any data entry.
- **User:** owner / founder.
- **Inputs / outputs:** name, email, password, company name, fiscal year start → user, organization, owner membership, default chart of accounts, default warehouse.
- **Rules / edge cases:** email unique (case-insensitive); password ≥ 10 chars; one organization per signup; org gets US-English defaults (USD, `MM/DD/YYYY`).
- **Depends on:** nothing.
- **Evidence:** 1C delivers through partners and implementation projects (V, S1, S6); a self-serve signup is not described on pages read.
- **4VEKO:** self-serve signup, one transaction creates everything, seeded US chart of accounts.
- **UX opportunity:** working ledger in under a minute; no implementation project.
- **Priority:** must.

### A2. Organization settings, users and roles
- **Problem:** control who can see and change financial data.
- **User:** owner, admin.
- **Inputs / outputs:** org profile, base currency, default sales tax rate, books-closed-through date; members with role (owner, admin, accountant, sales, viewer).
- **Rules:** only owner/admin manage members; the last owner cannot be removed or demoted; role checks on every API route.
- **Evidence:** access rights by user role (V, S5).
- **4VEKO:** fixed role set with a permission map in code (custom roles later).
- **Priority:** must.

### A3. Customers and vendors
- **Problem:** shared master data for selling and buying.
- **User:** sales, purchasing, accounting.
- **Inputs / outputs:** name, email, phone, billing address, payment terms (net days), tax-exempt flag, notes → customer / vendor record with balance.
- **Rules:** display name unique per org and type; archived instead of deleted when referenced by documents.
- **Evidence:** catalogs hold customers and products (V, S5); settlement tracking with buyers and suppliers (V, S17).
- **4VEKO:** one `parties` table with a `kind` (customer/vendor) for consistent behaviour.
- **UX opportunity:** balance and open documents on the detail page; create inline from a sales order.
- **Priority:** must.

### A4. Products and services catalog
- **Problem:** consistent pricing, accounts and stock tracking for what a business sells.
- **Inputs / outputs:** SKU, name, type (inventory, non-inventory, service), unit price, unit of measure, income account, taxable flag → item.
- **Rules:** SKU unique per org; inventory items need inventory and COGS accounts; type cannot change after stock moves.
- **Evidence:** catalogs for products (V, S5); item kinds (V, S2).
- **Priority:** must.

### A5. Chart of Accounts
- **Problem:** structure for the General Ledger.
- **Inputs / outputs:** number, name, type (asset, liability, equity, revenue, expense), subtype, parent, active flag → account.
- **Rules:** number unique per org; type immutable once the account has postings; system accounts (AR, inventory, sales tax payable, undeposited funds) cannot be archived; normal balance derived from type.
- **Evidence:** accounting registers (V, S5); accounting and tax records (V, S15). The 1C chart of accounts itself was not examined.
- **4VEKO:** a US small-business template written from standard US practice (P).
- **Priority:** must.

### A6. General Ledger and journal entries
- **Problem:** a complete, balanced, auditable record of every financial event.
- **Inputs / outputs:** date, memo, lines (account, debit or credit, description) → posted entry with a sequential number; trial balance; account ledger.
- **Rules:** debits equal credits (checked in code and by a deferred database trigger); each line is debit-only or credit-only and positive; posted entries are immutable (database trigger) and corrected by reversing entries; no posting on or before the books-closed date; amounts are `numeric(18,2)`, never floats.
- **Evidence:** month-end closing (V, S3, S15); drill-down from balance sheet to documents (V, S3).
- **4VEKO:** single posting service used by every module; each entry links to its source document.
- **UX opportunity:** every entry shows its source document and vice versa, one click each way.
- **Priority:** must.

### A7. Sales orders
- **Problem:** capture what the customer committed to buy before billing.
- **Inputs / outputs:** customer, order date, lines (item, qty, unit price, discount %) → draft → confirmed → invoiced | cancelled.
- **Rules:** cannot confirm an empty order; only drafts are editable; invoiced orders cannot be cancelled; totals computed server-side.
- **Evidence:** sale orders drive demand (V, S2); order chain from sales to stock (V, S7).
- **Priority:** must.

### A8. Invoices
- **Problem:** bill the customer and recognize revenue and receivables.
- **Inputs / outputs:** from a confirmed sales order (one click) or standalone → posted invoice with number, due date from terms, GL entry (Dr AR; Cr revenue per item; Cr sales tax payable; Dr COGS / Cr inventory for stocked items), stock decrease.
- **Rules:** posting is one database transaction (invoice, GL, stock) or nothing; an order can be invoiced once (unique constraint stops double submission); insufficient stock blocks posting with a clear message; void reverses GL and stock only when no payments are applied.
- **Evidence:** invoices are documents (V, S5); sales and invoicing workflows (V, S1, S17).
- **Priority:** must.

### A9. Customer payments
- **Problem:** record money received and clear receivables.
- **Inputs / outputs:** customer, date, amount, method, deposit account, applications to invoices → payment, GL entry (Dr cash/undeposited funds, Cr AR), updated invoice balances and statuses.
- **Rules:** applications cannot exceed the payment or any invoice's open balance; idempotency key prevents duplicates on retry; invoice rows locked during application to stop races.
- **Evidence:** bank and cash, settlement control (V, S17).
- **Priority:** must.

### A10. Inventory tracking
- **Problem:** know what is on hand and what it cost.
- **Inputs / outputs:** stock adjustments (receive or write down, with unit cost) and invoice shipments → quantity on hand, moving-average unit cost, movement history, GL entries.
- **Rules:** no negative stock (MVP); cost by moving average; every movement links to its source document.
- **Evidence:** inventory and warehouse management (V, S1); lot accounting with FIFO (V, S3).
- **4VEKO:** moving average for MVP; FIFO lots and multi-warehouse transfers planned.
- **Priority:** must.

### A11. Dashboard
- **Problem:** see the state of the business at a glance.
- **Outputs:** revenue this month and year, open receivables, overdue receivables, cash balance, AR aging, top customers, low stock, recent activity.
- **Evidence:** KPI dashboard (V, S1).
- **Rules:** every number is computed from the ledger or posted documents, never cached separately in the MVP.
- **Priority:** must.

### A12. Audit history
- **Problem:** who did what, when, for accountability and investigations.
- **Outputs:** append-only log of create/update/post/void/reverse/login/member changes with actor, entity and a JSON summary.
- **Evidence:** activity analysis (V, S5); personal-data access logs (V, S18).
- **Rules:** audit rows cannot be updated or deleted (database trigger).
- **Priority:** must.

### A13. Financial reports
- Trial balance, Profit and Loss, Balance Sheet, AR aging. **Evidence:** balance sheet, gross profit, income and expense reports (V, S3); 100+ reports (V, S7). **Priority:** must (these four), should (the rest).

## B. Next features (summary table)

| # | Area | Feature | Problem solved | Evidence | 4VEKO approach | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Procurement | Purchase orders and vendor bills, bill payments, AP aging | Procure to pay; liabilities | V S3 (POs, vendor invoices) | Mirror of A7-A9 for vendors; three-way match later | should |
| B2 | Inventory | Multiple warehouses and transfers | Stock per location | V S2 (stockrooms) | `locations` table already in schema | should |
| B3 | Inventory | FIFO / lot tracking, serial numbers | Cost accuracy, traceability | V S3 (FIFO lots), V S2 (batch reports) | Cost layer table | could |
| B4 | Banking | Bank feeds, reconciliation | Match books to bank | V S13 (DirectBank: Russian bank exchange) | Plaid-class aggregator, statement import first | should |
| B5 | Sales | Partial invoicing, credit notes, quotes | Real-world billing | I | Invoice lines reference order lines | should |
| B6 | Sales tax | Tax rates by jurisdiction, tax engine integration | US sales tax | V S15 (tax calc, Russian regimes, not applicable) | Integrate a US tax engine via its official API; no compliance claim | should |
| B7 | Multi-company | Several legal entities, intercompany, consolidation | Groups and holdings | V S3, S9, S16 | `organizations` already isolate data; add "company" within tenant | could |
| B8 | Multi-currency | Foreign currency documents, revaluation | International trade | V S4 (scenario currencies) | Currency on documents, rate table | could |
| B9 | Platform | Custom fields on records | Fit the product to the business | V S5 (configuration objects, low-code) | JSONB values validated against field definitions | should |
| B10 | Platform | Approval workflows | Spend control | V S4 (payment limits) | Rule engine on document events | should |
| B11 | Platform | Webhooks and API keys | Integrations | V S5 (REST, OData) | Signed outbound webhooks, scoped API tokens | should |
| B12 | Platform | CSV import/export | Onboarding from old systems | V S13 (exchange formats) | Import wizard with dry run | should |
| B13 | Platform | Global search and command palette | Find anything fast | I | Implemented in MVP (P) | must |
| B14 | Budgeting | Budgets, plan vs actual | Financial planning | V S4 | Budget lines by account and period | could |
| B15 | Fixed assets | Asset register, depreciation | Capital assets | V S3 (asset dimensions), V S15 (fixed assets label) | Straight-line first | could |
| B16 | Manufacturing | BOMs, work orders, routing | Make products | V S2, S8 | Single-level BOM and assembly first | could |
| B17 | CRM | Leads, pipeline, activities | Sell more | V S7 (pipeline), S1 (CRM) | Opportunities linked to customers | could |
| B18 | HR | Employee records | People master data | V S18 | Basic records; payroll via integration | could |
| B19 | Payroll | US payroll processing | Pay staff | V S18 (Russian payroll) | Integrate a US payroll provider first; own engine needs professional review | could |
| B20 | Documents | Attachments on records | Paper trail | I | S3-compatible storage | should |
| B21 | BI | Saved report views, export, scheduled email | Analysis | V S4, S5 | Report builder on ledger views | should |
| B22 | AI | Assistant to explain reports and find data | Faster answers | none (P) | Permission-scoped retrieval, no autonomous posting | could |
| B23 | Projects | Projects, time, job costing | Services firms | V S17 (work tasks, acts) | Project dimension on lines | could |
| B24 | Mobile | Mobile and offline | Field work | V S14 | Responsive web first | could |
| B25 | Regulated reporting | Russian statutory e-filing, FSTEC-certified builds | Russian compliance | V S15, S18 | Not applicable to the US market | skip |
| B26 | Platform | Proprietary scripting language and IDE | Deep customization | V S5 | Replace with REST API + custom fields + standard languages | skip |
