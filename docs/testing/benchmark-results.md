# Benchmark results

## Dated closing reports on the November 18 engineering increment

`apps/api/scripts/bench.ts` exercised the authenticated Fastify routes and PostgreSQL 18.6
using Node 24.15.0 on an i5-12450H with 16 GB RAM. The larger fixture contained 1,110 invoices
and 9,067 journal lines after adding 1,000 invoice/payment pairs. The trial balance balanced.
Each endpoint had five warm-up requests and 50 measured reads. Timings exclude HTTP transport.

| GET report | Seeded p95 (ms), final schema | Larger fixture p50 (ms), final schema | Larger fixture p95 (ms), final schema |
| --- | ---: | ---: | ---: |
| AR aging | 18.9 | 20.0 | 25.8 |
| AP aging | 4.8 | 4.3 | 4.8 |
| Control reconciliation | 23.2 | 36.8 | 55.4 |

This run includes migrations 0005 and 0006, with 2,319 sealed journals. Invoice creation
and payment recording had p95 of 24.6 and 19.0 ms over 1,000 writes each. An earlier run
on the 0004 schema had larger-fixture AR/AP/reconciliation p95 of 6.9/2.8/10.6 ms.
Machine contention varied between the runs.

These measurements use a single local caller. Capacity planning still needs multi-user and
larger tenant fixtures. To repeat, point `TEST_DATABASE_URL` at a fresh disposable benchmark
database before running `npm run bench -w @4veko/api`.

## 1. API latency (measured 2026-10-28)

How: `npm run bench -w @4veko/api` (script: `apps/api/scripts/bench.ts`). It wipes the test
database, seeds the demo company, measures 50 requests per read after 5 warm-ups, posts
1,000 invoices (one service line + one stocked line) and 1,000 payments, then measures the
reads again. Requests go through the full Fastify pipeline (routing, validation, session,
permissions) and PostgreSQL via `inject`, so network time is excluded.

Machine: 12th Gen Intel Core i5-12450H (12 threads), 16 GB RAM, Windows 11, Node v24.15.0,
PostgreSQL 17 in Docker Desktop. Single run; numbers vary between runs and machines.
Data after the run: 1,103 invoices, 8,905 journal lines. Trial balance balanced: true.

| operation | samples | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| GET /dashboard — seeded | 50 | 29.7 | 50.7 | 77.6 |
| GET /invoices (100 rows) — seeded | 50 | 7.0 | 9.4 | 9.5 |
| GET /reports/trial-balance — seeded | 50 | 5.8 | 6.5 | 6.8 |
| GET /reports/balance-sheet — seeded | 50 | 20.0 | 34.1 | 52.6 |
| GET /reports/profit-and-loss — seeded | 50 | 5.6 | 7.0 | 8.5 |
| GET /reports/ar-aging — seeded | 50 | 5.0 | 8.5 | 9.5 |
| GET /search?q=bl — seeded | 50 | 5.1 | 6.8 | 9.4 |
| POST /invoices (post invoice + stock + GL) | 1000 | 26.6 | 51.0 | 81.8 |
| POST /payments (apply + GL) | 1000 | 20.7 | 40.0 | 61.8 |
| GET /dashboard — after +1,000 invoices | 50 | 30.9 | 42.3 | 49.5 |
| GET /invoices (100 rows) — after +1,000 invoices | 50 | 6.2 | 7.6 | 8.7 |
| GET /reports/trial-balance — after +1,000 invoices | 50 | 6.8 | 8.5 | 14.6 |
| GET /reports/balance-sheet — after +1,000 invoices | 50 | 14.6 | 17.7 | 19.6 |
| GET /reports/profit-and-loss — after +1,000 invoices | 50 | 8.2 | 10.1 | 13.3 |
| GET /reports/ar-aging — after +1,000 invoices | 50 | 4.9 | 6.7 | 7.4 |
| GET /search?q=bl — after +1,000 invoices | 50 | 4.9 | 7.9 | 10.2 |

Against NFR-3 (p95 < 150 ms): met for every measured operation at this size.
Not yet measured: 100k+ invoices, concurrent users, browser rendering time, a production host.
The dashboard and balance sheet compute everything live from journal lines; at much larger
volumes they will need summary tables or materialized balances.

## 2. Workflow step counts (4VEKO only)

Counted from the Playwright flow in `apps/web/e2e/order-to-cash.spec.ts`:

| Task | UI actions in 4VEKO |
| --- | ---: |
| Existing customer and item → posted invoice | 4 (customer, item, quantity, "Save and invoice") |
| Invoice → full payment recorded | 2 ("Record payment", then "Record payment") |
| Find any customer, invoice, item or account | 2 (Ctrl/⌘ K, type) |

## 3. Comparison with 1C

**Not performed.** We have no lawfully licensed 1C environment configured comparably, and
1C's public pages give no step counts or timings for these tasks. Vendor-published outcome
figures on 1ci.com (e.g. "+85% order processing speed") have no stated baseline and are not
comparable. No superiority claim is made. To run one: license a 1C product for the US market,
have the same trained user perform the tasks in section 2 in both systems on similar
hardware, record actions and wall-clock time, and publish the method with the results.
