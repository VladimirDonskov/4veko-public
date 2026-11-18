# Architecture overview

For the current ERP and VekoScript ownership boundaries, deployment paths and integration work, see the [platform architecture](platform-architecture.md). The ADRs below describe the original ERP foundation.

The ERP core is a **modular monolith** with a Fastify API, a Next.js client and one
authoritative PostgreSQL database for its transactions. ERP modules share master data (organizations, parties,
items, accounts) and one posting service, so a sales invoice, its stock
movement and its General Ledger entry are written in the same database
transaction.

```
 browser ──► apps/web (Next.js, React, TanStack Query)
               │  same-origin /api/* rewrite (cookies stay first-party)
               ▼
            apps/api (Fastify + Zod + OpenAPI)
               ├─ platform: auth, sessions, orgs, members, roles, audit, search, numbering
               ├─ master data: parties (customers, vendors), items, accounts, locations
               ├─ ledger: posting service, journal entries, reversals, period lock
               ├─ sales: sales orders, invoices, payments
               ├─ purchasing: purchase orders, receipts, vendor bills, bill payments
               ├─ inventory: stock levels, movements, adjustments (moving average)
               └─ reporting: trial balance, P&L, balance sheet, AR aging, dashboard
               ▼
            PostgreSQL 17 (Drizzle ORM, versioned SQL migrations,
                           integrity triggers, composite tenant keys)
```

## Module boundaries

| Module | Owns tables | Talks to |
| --- | --- | --- |
| platform | users, organizations, memberships, sessions, number_sequences, audit_events | everyone (auth context, audit, numbering) |
| master data | parties, items, accounts, locations | ledger (account validation) |
| ledger | journal_entries, journal_lines | nobody: every other module calls `postJournalEntry()` |
| sales | sales_orders(+lines), invoices(+lines), payments, payment_applications | ledger, inventory |
| purchasing | purchase_orders(+lines), purchase_receipts(+lines), bills(+lines), bill_payments, bill_payment_applications | ledger, inventory |
| inventory | stock_levels, stock_moves, inventory_adjustments(+lines) | ledger |
| reporting | none (read-only over the above) | ledger, sales, inventory |

Rule: a module never writes another module's tables directly. Sales calls
`inventory.issueStock()` and `ledger.postJournalEntry()` inside the caller's
transaction.

## Request lifecycle

1. Fastify parses and validates input with Zod (the same schemas generate the
   OpenAPI document at `/api/docs`).
2. The session plugin resolves the cookie to `{ user, organization, role }`.
3. The route checks a named permission (`requirePermission('journal.post')`).
4. The service runs in a database transaction; every query is scoped by
   `organization_id`, and composite foreign keys make cross-tenant references
   impossible at the database level.
5. Critical operations write an audit event in the same transaction.
6. Errors map to a single JSON shape: `{ "error": { "code", "message", "details" } }`.

## Architecture decision records

### ADR-001 Modular monolith, not microservices
Accounting needs atomic multi-table writes (document + stock + ledger). One
database transaction gives that for free; distributed transactions do not.
Module boundaries live in folders and function calls, so a module can be
extracted later if load demands it.

### ADR-002 Fastify + Zod instead of NestJS
The brief allowed NestJS "or another well-justified framework". We chose
Fastify 5 with `fastify-type-provider-zod`: one Zod schema per route gives
request validation, TypeScript types and the OpenAPI document with no
decorator/DTO duplication. Fastify plugins provide the module boundary that
Nest modules would. Trade-off: no built-in dependency injection container;
services are plain functions taking a transaction handle, which keeps them
easy to test.

### ADR-003 PostgreSQL + Drizzle ORM, SQL migrations
Drizzle gives typed queries and generates SQL migration files that are
checked in. Integrity rules that must hold no matter which code path writes
(balanced entries, immutability, period lock, tenant consistency) are
enforced **in the database** with constraints and triggers in a hand-written
migration, not only in application code.

### ADR-004 Money as `numeric` + decimal.js
Amounts are `numeric(18,2)`, quantities `numeric(18,4)`. The driver returns
them as strings; all arithmetic uses `decimal.js` with half-up rounding to
cents at line level. JavaScript `number` is never used for money.

### ADR-005 Posted entries are immutable
Journal lines cannot be updated or deleted (trigger). A correction is a
reversing entry linked to the original. Voiding an invoice posts a reversal;
nothing is erased.

### ADR-006 Moving-average inventory valuation, value tracked in cents
Each stock level stores `qty_on_hand` and `value_on_hand` (cents). Issues
take `round(value × qty_out / qty_on_hand, 2)` and an issue that empties the
bin takes the full remaining value, so the Inventory account balance always
equals the sum of `value_on_hand` exactly. FIFO lots are planned (B3).

### ADR-007 Tenant isolation by composite keys (RLS planned)
Every tenant table has `organization_id`; every cross-table reference is a
composite foreign key `(organization_id, x_id)`. The API scopes every query
by the session's organization. Postgres row-level security as a second
line of defence is planned (needs a non-owner DB role and per-transaction
`set_config`), see `security.md`.

### ADR-008 Opaque server-side sessions
Random 256-bit token in an HttpOnly, SameSite=Lax cookie; only its SHA-256
hash is stored. Sessions can be revoked instantly (sign-out, member removal).
JWTs were rejected because revocation is the property we need most.

### ADR-009 Same-origin web and API
Next.js rewrites `/api/*` to the API, so the browser sees one origin: no
CORS, first-party cookies. Mutating requests must be JSON and, when an
`Origin` header is present, it must match the configured web origin (CSRF
defence in depth).

### ADR-010 English-first, US defaults
USD, US date format, US small-business chart of accounts template, US
terminology. Localization hooks (currency on organization, `Intl` formatting)
exist; translations are not in scope.

## Directory layout

```
apps/api            Fastify API (src/modules/*, src/db, src/lib), Vitest tests
apps/api/drizzle    versioned SQL migrations
apps/web            Next.js app (app router), Playwright e2e in apps/web/e2e
docs/               research, product, architecture, design, testing
replica/            replica-skill working artifacts
docker-compose.yml  postgres + api + web
```

## Background processing

None is required for the MVP: all postings are synchronous. Planned jobs
(webhook delivery, scheduled reports, bank feed sync) will use a Postgres-
backed queue (e.g. pg-boss) before introducing Redis.
