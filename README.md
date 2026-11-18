# 4VEKO

An English-first business management platform for US small and mid-size businesses:
General Ledger, sales orders, invoicing, customer payments, purchasing, vendor bills and
inventory in **one system of record**. Posting an invoice writes the receivable, revenue, sales tax, cost of goods sold, the
stock movement and the audit record in a single database transaction.

Status: **Release 0.1 foundation + Release 0.2 procure-to-pay**: working and tested, not
production-ready.
See the [engineering checkpoint](docs/product/implementation-progress.md) for the latest
verified increment and the [ecosystem roadmap](docs/product/full-ecosystem-roadmap.md)
for the remaining work.

**VekoScript**, the platform's own business language, lives in
[`engine/vekoscript`](engine/vekoscript) (Rust engine and isolated worker) and
[`backend`](backend) (Java/Spring Boot platform on PostgreSQL). Start with
[docs/vekoscript](docs/vekoscript/README.md); current status is in
[runtime.md](docs/vekoscript/runtime.md#status).

With the platform service enabled, open **Studio** to check VekoScript source, review its
migration plan and publish a revision. Setup and end-to-end verification are in the
[Studio guide](docs/vekoscript/editor.md).

## Run it locally

Requirements: Node 22.12+ (24 used), Docker Desktop, Python 3 (only for replica tools).

```bash
npm install
```

```bash
docker compose up -d db
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

Then start the API and the web app in two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:3000. The seed creates a fictional company, **Harbor & Pine Supply Co.**,
with a year of orders, invoices, payments, restocks and expenses. Local demo sign-ins are listed
at the top of [`apps/api/src/db/seed.ts`](apps/api/src/db/seed.ts) (owner, accountant, sales and
viewer roles). Or click **Create an account** to start an empty company.

API documentation (OpenAPI): http://localhost:4000/api/docs

The API reads [`apps/api/.env`](apps/api/.env.example) (copy `.env.example`). Postgres runs on
port **5433** so it does not collide with a local PostgreSQL on 5432.

### Everything in containers

```bash
docker compose --profile app up --build
```

The API container applies migrations on start. Seed it once with
`docker compose exec api node dist/db/seed.js`.

## The golden path to try

1. **Customers → New customer.**
2. **Sales Orders → New sales order**, pick the customer and items, **Save and invoice**.
3. On the invoice, see the **General Ledger impact**, then **Record payment** (pre-filled).
4. **Reports → Receivables Aging / Trial Balance / Balance Sheet**, then the **Dashboard**.

And the buying side:

1. **Purchase Orders → New purchase order**, issue it, then **Receive items** (stock goes up).
2. **Enter bill** from the order; change the unit cost to see the price variance in the ledger.
3. **Pay bill**, then **Reports → Payables Aging**.

Press **Ctrl/⌘ K** anywhere to search or run a command; `/` filters any table.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

The API suite covers ledger invariants, database-level immutability and period lock, three-way
matching, dated AR/AP reconciliation, concurrent operations, tenant isolation and migrations.
Playwright covers the sales, purchasing and period-close workflows, including accessibility
scans. Counts and environment details are in the [engineering checkpoint](docs/product/implementation-progress.md).
See the [test plan](docs/testing/test-plan.md),
[benchmarks](docs/testing/benchmark-results.md), [defects](replica/bugs.md).

## Repository layout

```
apps/api     Fastify + Zod + Drizzle API, migrations (drizzle/), tests (test/), bench (scripts/)
apps/web     Next.js app (src/app), components, Playwright tests (e2e/)
docs/        research, product, architecture, design, testing
replica/     replica-skill artifacts: recon, features.csv, parity, design tokens, bugs, brand
infra/       Postgres init (creates the test database)
```

## Documentation

- Research: [competitor analysis](docs/research/competitor-analysis.md) · [feature matrix](docs/research/feature-matrix.md)
- Product: [requirements](docs/product/requirements.md) · [roadmap](docs/product/roadmap.md)
- Architecture: [overview and ADRs](docs/architecture/overview.md) · [data model](docs/architecture/data-model.md) · [security](docs/architecture/security.md)
- Design: [design system](docs/design/design-system.md)
- Testing: [test plan](docs/testing/test-plan.md) · [benchmark results](docs/testing/benchmark-results.md)

## Independence and intellectual property

4VEKO is an independent product. Competitive research used only public web pages, recorded with
URLs in the research folder; no competitor software was installed, decompiled or accessed, and no
code, schema, configuration, interface, icon or text was copied. Business logic follows standard
double-entry accounting practice. Fonts (Inter, SIL OFL) and icons (Lucide, ISC) are openly
licensed. The Apache Maven Wrapper scripts in `backend` are distributed with the
[Apache License 2.0](backend/.mvn/wrapper/LICENSE) and their [upstream notice](backend/.mvn/wrapper/NOTICE).

No legal, tax, payroll, security or accounting-standard compliance is claimed. Sales tax is a
single configurable rate per organization and is not a substitute for a tax engine.
