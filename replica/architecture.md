# Architecture: 4VEKO (an independent platform covering the order-to-cash and record-to-report jobs studied in 1C)

Full detail: `docs/architecture/overview.md` (ADRs), `docs/architecture/data-model.md`,
`docs/architecture/security.md`.

## Stack

| layer | choice | why |
| --- | --- | --- |
| web | Next.js 16, React 19, TypeScript, Tailwind 4, TanStack Query, Radix Dialog, cmdk | brief's preferred stack; fast client navigation for a data app |
| api | Fastify 5 + Zod (fastify-type-provider-zod) + OpenAPI | one schema gives validation, types and docs (ADR-002) |
| database | PostgreSQL 17, Drizzle ORM, SQL migrations | transactions, numeric money, constraints and triggers for ledger rules |
| auth | own opaque sessions (hashed tokens, HttpOnly cookies), scrypt passwords | revocable, no third-party dependency for the MVP |
| payments | none in MVP (customer payments are recorded, not processed) | Stripe-class processing is a later integration |
| email | none in MVP | invitations and invoice email are Release 0.2 |
| jobs | none needed yet; pg-boss planned | avoid Redis until justified |
| hosting | Docker images + Compose; host to be chosen | deploy requires the owner's authorization |

## Schema

22 tables; tenant isolation by composite foreign keys; ledger rules in database triggers.

## API

40+ routes under `/api/v1`, all documented at `/api/docs`. Flows: F01 order to cash
(`/sales-orders`, `/sales-orders/:id/invoice`, `/invoices`, `/payments`), F02 journal
(`/journal-entries`, `/:id/reverse`), F03 inventory (`/inventory/adjustments`), F04 access
(`/auth/*`, `/org/members`), F05 close (`PATCH /org` booksClosedThrough), reports and dashboard.

## The parts that bite

- time zones: business dates are `date` strings; server-local "today" until org time zones exist.
- idempotency: payments take `Idempotency-Key`; order invoicing is protected by a row lock and a partial unique index.
- races: row locks on orders, invoices and stock levels in a stable order; tested with concurrent requests.

## Build order (as executed)

1. Vertical slice: signup → customer → item → stock → order → invoice → payment → GL → dashboard. Done.
2. Must-haves: all 18 done (`replica/parity-score.md`).
3. Should-haves: Release 0.2/0.3 in `docs/product/roadmap.md`.
