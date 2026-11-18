# Competitor analysis: 1C (1C-Soft / 1C International)

The [ecosystem comparison index](../product/1c-functional-parity.md#public-comparison-sources)
extends this 1C research with public Microsoft, Oracle, Odoo, SAP and Intuit material. Its
capability IDs distinguish published product scope from 4VEKO's own acceptance requirements.

Research date: 2026-10-28. Method: clean-room. We read public marketing and
product pages only, paraphrased them, and recorded each claim with its URL.
We did not sign in, download software, read source code, inspect network
traffic, or use a 1C account. Nothing in this repository is derived from 1C
code, configuration files, schemas, UI text or assets.

Evidence labels used throughout this folder:

- **V (verified):** stated on the cited public page, read on 2026-10-28.
- **I (inferred):** our reasonable reading of what the pages imply, or
  general industry knowledge of how ERP products of this class work. Not
  confirmed against 1C itself. Treat as a hypothesis.
- **P (proposed):** our own design for 4VEKO. Not a claim about 1C.

## 1. Source register

| # | URL | Status | What it gave us |
| --- | --- | --- | --- |
| S1 | https://www.1ci.com/applications/1c-erp/ | read, HTTP 200 | 1C:ERP module list, deployment, targets, vendor outcome claims |
| S2 | https://www.1ci.com/applications/1c-erp-production-subsystem/ | read | production planning, BOMs, work centers, MES |
| S3 | https://www.1ci.com/applications/1c-erp-expense-management-and-cost-calculation/ | read | cost accounting, accounting views, month-end, multi-company |
| S4 | https://www.1ci.com/applications/1c-erp-budgeting-subsystem/ | read | budgeting, payment limits, scenarios, variance reports |
| S5 | https://www.1ci.com/developers/ | read | platform model: configuration objects, IDE, app server, integration, DBMS list |
| S6 | https://www.1ci.com/applications/ | read | international product line, partner-led delivery |
| S7 | https://www.1ci.com/applications/1c-drive/ | read | 1C:Drive (mid-market sales/services/production) |
| S8 | https://www.1ci.com/applications/1c-drive-production/ | read | 1C:Drive production edition |
| S9 | https://www.1ci.com/applications/1c-perform/ | read | holding-company consolidation and CPM |
| S10 | https://www.1ci.com/ | read | home page, 1C:Jet mention |
| S11 | https://v8.1c.ru/ | read (Russian) | platform news, Russian product catalog names, scale claims |
| S12 | https://v8.1c.ru/platforma/ | read, headings only | platform capability headings |
| S13 | https://v8.1c.ru/tekhnologii/obmen-dannymi-i-integratsiya/ | read | integration formats and protocols |
| S14 | https://v8.1c.ru/tekhnologii/mobilnye-tekhnologii-1s/ | read | mobile platform, offline mode |
| S15 | https://v8.1c.ru/buhv8/ | read, top page only | 1C:Accounting 8 |
| S16 | https://v8.1c.ru/trade/ | read, top page only | 1C:Trade Management 8 |
| S17 | https://v8.1c.ru/small.biz/ | read, top page only | 1C:Small Business ("Managing Our Firm", UNF) |
| S18 | https://v8.1c.ru/hrm/ | read, top page only | 1C:Salary and HR Management 8 |
| S19 | https://solutions.1c.ru/catalog/1cerp/features | **not accessed** | returned HTTP 429 (rate limited). Not retried. The Russian 1C:ERP feature catalog is therefore missing. |
| S20 | https://hn.algolia.com/api/v1/search?query=1C%3AEnterprise and `query=1C%20accounting` | read | 9 public Hacker News comments (see `replica/reviews.csv`) |
| S21 | G2, Capterra, TrustRadius, Software Advice | **blocked (HTTP 403)** | no end-user reviews collected from review sites |

Known gaps to close in a later research pass (each needs only a normal
browser visit by a person): S19; the 1C:ERP User's Guide at
`https://kb.1ci.com/bin/view/OnecInt/KB/1C_ERP/Guides/` (linked from S1);
the sub-pages of S15-S18 (feature detail, editions); the system requirements
page on v8.1c.ru; review-site pages for 1C:Drive and 1C:ERP.

## 2. Platform versus applications (do not treat 1C as one product)

1C is a **platform plus a family of applications** built on it.

- **1C:Enterprise (the platform)** is a low-code development framework: an
  IDE, a set of configurable building blocks called configuration objects,
  and an application server (V, S5). Configuration objects are metadata
  classes for business entities; the pages name catalogs (lists such as
  customers, products, employees), documents (business events such as
  purchase orders, sales orders, invoices), accounting registers and payroll
  registers (V, S5). Customization is possible visually, in a built-in
  scripting language, and by editing application source, which 1C exposes
  for customizing its packaged applications (V, S5). Clients: browser,
  desktop and mobile, including fully offline mobile apps that sync later
  (V, S5, S14). Supported databases named: Microsoft SQL Server, PostgreSQL,
  IBM Db2, Oracle (V, S5). Integration: HTTP web services (REST and SOAP),
  JSON and XML, OData, ODBC, COM, plus 1C-specific exchange formats
  (EnterpriseData, CommerceML), bank exchange and EDI (V, S5, S13).
- **Applications ("configurations")** are packaged business solutions built on
  the platform, shipped as "typical configurations" with their own version
  numbers (V, S11). They are deployable as-is or adjusted, and 1C says its
  international products generally need partner implementation (V, S6, S1).

How the platform turns documents into accounting entries ("posting" to
registers) is widely described in 1C developer literature but was **not
stated on any page we read**, so we record it as I (inferred), not V.

## 3. Product line relevant to 4VEKO

| Product | Purpose (V) | Target (V) | Source |
| --- | --- | --- | --- |
| 1C:ERP | Production planning, cost calculation, budgeting, inventory/warehouse, sales and procurement, CRM, KPI monitoring. Cloud or on-premises, mobile access. | Medium and large manufacturers; projects from 5 to 20,000+ workstations | S1-S4 |
| 1C:Drive | One order chain from sales and purchasing through production to stock; 100+ reports; leads and pipeline; e-commerce and POS connections; Android/iOS app | Medium businesses (sales & services, or production edition) | S7, S8 |
| 1C:Perform | Holding consolidation with intercompany eliminations and IFRS mapping, multi-level budgeting, balanced scorecard | Holding companies | S9 |
| 1C:Accounting 8 | Accounting and tax records, regulated reporting with e-filing, month-end closing; versions from sole proprietors to holdings | Professional accountants | S15 |
| 1C:Trade Management 8 | Operational and management accounting for trading companies: retail, wholesale, commission; multiple legal entities; passes data to 1C:Accounting | Trading companies, all sizes | S16 |
| 1C:Small Business (UNF) | One program for sales, warehouse, services, purchasing, bank and cash, payroll, light production, CRM; "no accounting knowledge needed" | Small traders, service firms, make-to-order shops | S17 |
| 1C:Salary and HR Management 8 | Payroll calculation, HR records, staffing, time tracking, statutory reporting, personal-data protection | HR and payroll departments | S18 |

Observation (I): in the Russian line, operational applications (Trade,
Small Business) hand data to a separate accounting application for
statutory books (V that the hand-off exists, S16, S17). A US small or
mid-size business expects one system of record where an invoice and its
General Ledger impact are the same transaction. That is a structural
opportunity for 4VEKO (P).

## 4. Business workflows observed

| Workflow | What the pages state | Source |
| --- | --- | --- |
| Order to cash | Sales orders create demand; profitability by order, manager, product group; settlement tracking with buyers | S2, S3, S17 |
| Procure to pay | Purchase orders, vendor invoices as cost dimensions; supply forecasting; purchasing planned against production and sales | S2, S3 |
| Plan to produce | Three planning levels, multi-level stage-based BOMs, work centers, routings, shop-floor dispatch, MES | S2, S8 |
| Record to report | Management, local and tax accounting views; month-end closing workplace; balance sheet with drill-down to documents | S3, S15 |
| Budget to control | Budget models, payment limits checked when a payment request is created, plan-vs-actual reports | S4 |
| Hire to pay | HR records, staffing table, time tracking, payroll, statutory filings | S18 |

## 5. Navigation, permissions, reporting, integration

- **Navigation:** pages describe role "workplaces" (for example a Month-end
  closing workplace, a Budgeting process schedule workplace, an order supply
  forecast workplace) (V, S3, S4, S2). We did not view the UI itself.
- **Permissions:** access rights by user role, activity analysis, encryption,
  TLS (V, S5). Personal-data access logging and consent records in the HR
  product (V, S18). Row-level restrictions are not mentioned on pages read.
- **Reporting:** adjustable financial and management reports (V, S5); named
  reports such as Gross profit, Income and expenses, Balance sheet statement
  (V, S3); 100+ reports in 1C:Drive (V, S7); always-on budget views (V, S4).
- **Integration:** see section 2. ERP page names TMS, WMS, CRM and accounting
  system integration without detail (V, S1).

## 6. User sentiment (thin sample)

Review sites blocked automated reading (S21). We collected 9 genuine public
Hacker News comments (S20; `replica/reviews.csv`). They are written mostly by
developers, about the platform's built-in programming language, and do not
represent accountant or ERP end-user experience. Recurring themes, by
mention count: dislike of the built-in language and code style (5), general
quality/usability criticism (2), platform lock-in to a Windows stack in one
2011 comment (1), and positives: wide use, a favorable assessment of the accounting software
from one commenter, and demand for developers (2). **This is not enough evidence to
claim what 1C customers dislike.** We make no such claims in product or
marketing copy. Collecting 100+ end-user reviews by hand is an open task.

## 7. Where an independent US product can compete (hypotheses, P)

These are hypotheses to validate with US customers, not established
weaknesses of 1C:

1. **English-first, US practice from day one:** US GAAP-style chart of
   accounts, AR/AP terminology, US date and currency formats, sales tax as a
   first-class concept. 1C's international pages exist, but its strongest
   regulatory depth (V, S15-S18) is Russian statutory reporting, which is
   irrelevant in the US.
2. **One system of record:** operations and the General Ledger in the same
   transaction, so there is no export or hand-off step (contrast with V,
   S16, S17).
3. **Self-serve SaaS:** sign up and work the same day, versus partner-led
   implementations of 3-4 months for 1C:ERP (V, S1) or 3-12 weeks for
   1C:Drive Production (V, S8).
4. **Customization without a proprietary language:** custom fields and
   objects through configuration, plus a public REST API and webhooks in
   standard JSON/OpenAPI, so customers use mainstream developers. (The HN
   sample's dislike of the built-in language is a weak signal only.)
5. **Modern UX:** command palette, keyboard-first tables, saved views,
   inline validation. To be measured (see `docs/testing/benchmark-results.md`);
   we will not claim faster workflows without a benchmark.

## 8. What we will not do

- Copy 1C code, configuration files, metadata, schemas, UI layouts, icons,
  terminology translations or documentation text.
- Translate Russian UI labels word for word. 4VEKO terms come from US
  accounting practice (General Ledger, Accounts Receivable, Sales Orders).
- Use 1C trademarks in product names, ads or listings.
- Benchmark against 1C unless we have a lawfully licensed, comparable
  environment; until then benchmark results compare 4VEKO only to its own
  targets.
