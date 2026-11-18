# Test plan and status

The [ecosystem acceptance criteria](ecosystem-acceptance-criteria.md) and
[engineering checkpoint](../product/implementation-progress.md) extend these original release scenarios.

Build: working tree, 2026-10-28 (not yet under git). Environment: Windows 11, Node 24,
PostgreSQL 17 (Docker), Chromium (Playwright 1.64).

## How to run

```bash
npm test                 # API: unit, integration, invariants, security, migrations (Vitest)
npm run test:e2e         # UI: Playwright, desktop and phone width (starts dev servers if needed)
npm run bench -w @4veko/api   # latency benchmark (wipes the test database)
```

## What ran and passed (last run 2026-10-28)

| Suite | File | Cases | Result |
| --- | --- | ---: | --- |
| Money arithmetic | `apps/api/test/money.test.ts` | 5 | pass |
| Ledger rules, immutability, period lock, reversal, audit | `apps/api/test/ledger.test.ts` | 12 | pass |
| Order to cash, concurrency, idempotency, stock, void, statements | `apps/api/test/order-to-cash.test.ts` | 16 | pass |
| Procure to pay: receiving, three-way match, variance, duplicates, payments, voids, AP/accrual reconciliation, permissions, isolation | `apps/api/test/purchasing.test.ts` | 18 | pass |
| Tenant isolation, roles, authentication, CSRF | `apps/api/test/security.test.ts` | 14 | pass |
| Migrations on an empty database | `apps/api/test/migrations.test.ts` | 1 | pass |
| **API total** | | **66** | **66 pass, 3 consecutive runs** |
| Order to cash through the UI + axe on 8 screens | `apps/web/e2e/order-to-cash.spec.ts` | 2 | pass |
| Procure to pay through the UI + axe on 6 screens | `apps/web/e2e/procure-to-pay.spec.ts` | 1 | pass |
| Phone width (no horizontal scroll on 8 screens, mobile menu) | `apps/web/e2e/responsive.spec.ts` | 1 | pass |
| Production builds (API bundle, Next.js) | `npm run build` | – | pass |
| Docker images: migrate on start, health, login and dashboard through the web proxy | manual smoke | – | pass |

## Cases by flow

**F01 Order to cash.** Happy path (UI and API); totals with discount and tax; one-click
invoicing; double click / 4 concurrent invoice requests → exactly one invoice; partial then full
payment; over-application rejected; overpayment kept as credit; 3 concurrent payments with one
idempotency key → one payment; 2 racing payments on one invoice → one succeeds; short stock →
422 and nothing persisted; 3 concurrent sales of the last units → one succeeds, stock and GL
reconcile; void → reversal, stock back, order reopened, re-invoicing allowed; void with payments
→ 409; AR and Inventory control accounts reconcile after every step; statements balance.

**F06 Procure to pay.** Order totals and draft editing; non-stocked items refused on orders; partial
receipt posts Dr Inventory / Cr Received Not Billed at order cost; over-receipt refused; 3 concurrent
"receive all" requests → exactly one receipt; billing more than received refused; bill at a higher
price books the variance; duplicate vendor invoice number (any case) refused; expense bills, with
bank/receivable accounts refused as expense lines; partial then full payment; over-payment refused;
keyed retries and racing payments; void unpaid bill restores billable quantity and allows re-entry
of the same reference; paid bill cannot be voided; closed order cannot receive or be cancelled;
AP, Received Not Billed and Inventory reconcile after each step; vendor balance = AP aging; sales
and viewer roles cannot buy or pay; another organization cannot read, receive or bill our orders.

**F02 Journal.** Balanced posting and numbering; unbalanced, both-sides, > 2 decimals rejected;
unbalanced entry rejected by the database when the API is bypassed; update/delete of posted rows
rejected; reversal once, linked both ways; no reversal of a reversal; archived account rejected;
system account and posted account type protected; list totals correct.

**F03 Inventory.** Opening stock, receipts and write-downs; moving-average cost; value clears
exactly when stock reaches zero.

**F04 Access.** Viewer read-only; sales cannot post journals, void, take payments or close books;
accountant cannot manage members; last owner protected; removal revokes sessions; anonymous
requests 401; foreign Origin 403; no account enumeration on login; duplicate email (any case)
409; session token stored hashed; passwords hashed with scrypt.

**F05 Close.** Books closed through a date block postings on and before it, in the API and the
database; reopening works and is audited.

**F07 Bank statement reconciliation.** Use existing cash postings on an active bank account.
Import identical statements concurrently, handle changed or duplicate references, and exercise
positive deposits, negative checks, wrong accounts, future dates and offsetting unmatched
items. Close with outstanding book items, carry a check into the next period, then reopen and
unmatch with an authorized user. The API fixture also clears actual customer and supplier
payments and checks that both source records and the journal count are preserved. The browser
fixture uses the import dialog, checks a historical statement on a phone viewport and runs axe.
See the [scenario and named suites](ecosystem-acceptance-criteria.md#bank-statement-reconciliation).

**F08 Grouped bank deposits.** Select receipts from two customers, post one bank journal line,
trace the original payments and clear the deposit on a bank statement. Race two posting
requests that share a receipt and race a void against a bank match. Verify that a dated
reversal releases the receipts on the correction date and preserves the earlier bank view.
Exercise invalid accounts, tenant roles, exact cent totals and posting to a closed period.
See the [deposit gates and fixtures](ecosystem-acceptance-criteria.md#grouped-bank-deposits).

## Not tested yet (known gaps)

- Manual screen-reader and keyboard-only passes; 200% zoom; forced-colors mode.
- Browsers other than Chromium (Firefox, Safari/WebKit).
- Load with many concurrent users; volumes above ~1,100 invoices.
- Production-scale restoration, recovery from archived WAL and measurement of upgrade lock duration. The [restore drill](restore-drill.md) and migration suite cover isolated fixtures.
- Rate-limit behaviour (no automated test); session expiry after 30 days.
- Time zones: "today" uses the server's local date; no organization time zone yet.
- Independent security review beyond the automated application tests and CI production dependency audit.

Defect log: `replica/bugs.md`.
