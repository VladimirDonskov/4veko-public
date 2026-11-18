# Recon map: 1C product family (web, desktop, mobile)

Scope: the order-to-cash and record-to-report loops of a US small/mid-size
business (customers, items, sales orders, invoices, payments, inventory,
General Ledger, financial reports). Manufacturing, payroll, budgeting and
consolidation are mapped as features but out of the first build.
For: 4VEKO, an independent English-first ERP for the US market.
Date: 2026-10-28

Full source register and evidence: `docs/research/competitor-analysis.md`.
Feature detail: `docs/research/feature-matrix.md`.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | product page | https://www.1ci.com/applications/1c-erp/ | modules, deployment |
| 2 | product pages | https://www.1ci.com/applications/1c-erp-expense-management-and-cost-calculation/ | accounting views, month-end |
| 3 | product page | https://www.1ci.com/applications/1c-erp-budgeting-subsystem/ | budgeting |
| 4 | product page | https://www.1ci.com/applications/1c-erp-production-subsystem/ | manufacturing |
| 5 | developer page | https://www.1ci.com/developers/ | platform model, integration, DBMS |
| 6 | product pages | https://v8.1c.ru/buhv8/ , /trade/ , /small.biz/ , /hrm/ | accounting, trade, SMB, payroll |
| 7 | feature catalog | https://solutions.1c.ru/catalog/1cerp/features | NOT ACCESSED (HTTP 429) |
| 8 | user's own account | none | the user has no 1C account in this project; no UI was observed |

## Core loop

A business records what it sells and buys as documents, and those documents
keep stock, receivables and the books up to date.

## Screens

No 1C screen was viewed (no account, no screenshots, no walkthrough videos
watched). The pages name role "workplaces" (Month-end closing, Budgeting
process schedule, Order supply forecast) and reports (Gross profit, Income
and expenses, Balance sheet statement). We therefore do not have a 1C screen
inventory and will not invent one.

The 4VEKO screen inventory below is our own design derived from the
workflows, not from 1C layouts:

| ID | screen | route | purpose | states |
| --- | --- | --- | --- | --- |
| S01 | Sign up | /signup | create user + organization | empty, error |
| S02 | Sign in | /login | session | error |
| S03 | Dashboard | /dashboard | KPIs, AR aging, low stock, activity | empty org, filled |
| S04 | Customers | /customers, /customers/[id] | list, detail with balance | empty, filled, archived |
| S05 | Vendors | /vendors | list, detail | empty, filled |
| S06 | Products & services | /items, /items/[id] | catalog with stock | empty, filled |
| S07 | Sales orders | /sales-orders, /new, /[id] | create, confirm, invoice | draft, confirmed, invoiced, cancelled |
| S08 | Invoices | /invoices, /[id] | posted invoices, balance, payments | open, partial, paid, overdue, void |
| S09 | Payments | /payments, /payments/new | record and apply payments | empty, filled, error |
| S10 | Inventory | /inventory | on hand, value, adjustments, movements | empty, low stock |
| S11 | Chart of Accounts | /accounts, /accounts/[id] | accounts, balances, account ledger | filled |
| S12 | Journal entries | /journal, /journal/new, /journal/[id] | GL, manual entries, reversal | posted, reversed |
| S13 | Reports | /reports/* | trial balance, P&L, balance sheet, dated AR/AP aging, control account reconciliation | empty, loading, error, matches, signed difference |
| S14 | Settings | /settings, /settings/members | org profile, close books, members | filled, error |
| S15 | Audit log | /audit | who did what | filled |
| S16 | Studio | /studio, /studio/new, /studio/app/[name] | check an application, review and publish its version, browse published metadata | empty, checking, diagnostics, migration review, stale revision, published, read-only |

## Flows

```
F01 Order to cash (the vertical slice)
    S04 create customer -> S07 create sales order -> confirm -> invoice
    -> S09 record payment -> S08 invoice paid -> S12 inspect GL -> S03 dashboard
    edge: insufficient stock, double submit, partial payment, overpayment, closed period
F02 Manual journal entry and reversal
    S12 new -> post -> reverse
    edge: unbalanced, closed period, inactive account, zero lines
F03 Receive inventory
    S10 adjustment (receive qty at cost) -> GL Dr Inventory / Cr Opening Balance Equity
    edge: negative quantity beyond stock, zero cost
F04 Invite a teammate and restrict access
    S14 add member with role -> member signs in -> viewer cannot post
F05 Close the books
    S14 set books closed through date -> posting on/before date rejected
```

## Inferred data model (4VEKO's own, from standard accounting practice)

```
Organization  id, name, base_currency, books_closed_through, default_tax_rate
User, Membership(role)
Party         kind customer|vendor, display_name, email, terms_days, tax_exempt
Item          sku, name, type inventory|non_inventory|service, price, accounts
Account       number, name, type, subtype, normal balance, system flag
JournalEntry  number, date, memo, source_type, source_id, reversal link
JournalLine   account, debit, credit (numeric 18,2)
SalesOrder    number, customer, status, lines
Invoice       number, customer, sales_order, dates, totals, balance_due, status
Payment       number, customer, amount, deposit account, applications
StockLevel    item, location, qty_on_hand, avg_cost
StockMove     item, location, qty, unit_cost, source document
AuditEvent    actor, action, entity, data
confidence: our design (P); 1C's internal model was not examined
```

## Feature matrix

See `features.csv`. Must: 19, should: 13, could: 13, skip: 2.

## Out of scope

- Russian statutory reporting, e-filing and certified builds (not relevant to the US).
- 1C's proprietary scripting language, IDE and configuration format.
- 1C's partner network, licensed content and customer data.

## Size

Screens 15, flows 5, entities ~16. Hard parts: posting correctness and
immutability, concurrency on stock and payments, tenant isolation, audit.
Size: L (a quarter) for a production-quality MVP; the first vertical slice is M.
