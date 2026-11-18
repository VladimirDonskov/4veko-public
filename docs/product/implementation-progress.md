# 4VEKO engineering checkpoint

**November 18, 2026 · Grouped bank deposits.** This update adds bank statement reconciliation and grouped deposits to the initial public release at `8ad6a00`.

## Grouped bank deposits

Open **Accounting → Bank Deposits** to select up to 500 whole customer receipts from Undeposited Funds. Posting creates a single bank debit and a single credit to Undeposited Funds. Each receipt retains its original invoice applications and links to the deposit. The bank statement can clear the total against one transaction. [Bookkeeper workflow](../../README.md#group-receipts-into-a-bank-deposit)

An erroneous deposit can be voided with a date and reason. The reversal releases its receipts on that date and keeps the original journal, membership and audit trail. An explicit bank match must first be removed. A deposit included in the first approved opening balance is protected until that statement is reopened. A payment newly posted with a backdate after approval was absent from the approved figures and can be corrected. Deposit cancellation handles an erroneous booking before clearance. Returned checks, partial receipts and net processor settlements require their own documents.

The API suite passed 171 tests in 14 files on PostgreSQL 18.6, including 13 deposit cases. Coverage includes simultaneous posting across banks, match versus cancellation, first-opening approval, a full 500-receipt batch, exact high-value amounts, closed periods and organization isolation. Migration 0008 was applied twice to a populated 0007 fixture. The full ERP restore compared all 42 table and sequence fingerprints, the deposit source journal and its released receipts. [Restore drill](../testing/restore-drill.md)

The API and web workspaces passed type checking and production builds. All eight Chromium scenarios passed against the production builds using two workers. An earlier six-worker run timed out during sign-up in the sales and purchasing scenarios. The grouped deposit scenario covers posting, voiding, reusing receipts and clearing the new deposit on a bank statement. The production dependency audit reported zero known advisories.

## Bank statement reconciliation

Open **Accounting → Bank Reconciliation**. For an existing USD bank account, enter the statement period and opening and closing balances, then import the bank's stable transaction identifiers, dates, descriptions and signed amounts from CSV. An identical replay returns the original statement. A changed replay fails before writing. The first period assumes earlier activity already cleared. Start with an earlier statement when uncleared items predate the chosen opening. [CSV example](../../README.md#reconcile-a-bank-statement)

Each bank line can clear one posted journal line of the same signed amount on that account. Outstanding postings explain the difference between the bank and ledger balances. Statements close in sequence after every imported line has a match and the adjusted balances agree. Accountants can reconcile and close. Owners and administrators can also reopen in reverse order. The newest open statement can be discarded after removing its matches. The audit retains the approval figures when later backdated postings change the live totals.

| Verification on the bank increment | Result |
| --- | --- |
| API and PostgreSQL 18.6 | 157 tests passed in 13 files. The 13 bank cases cover simultaneous imports and matching, concurrent ledger posting and close, stale updates, tenant and account boundaries, large amounts, statement correction and import of 1,000 rows. |
| Browser and build | Seven ERP browser tests passed on the optimized build. The bank journey covered a two-month reconciliation, a late posting, read-only access, a phone viewport and an axe check. API and web typechecks passed. Both palettes passed 24 contrast pairs. |
| Upgrade and recovery | Tested populated 0004 → 0007 and migration replay. Recovered the ERP fixture into a separate database and verified all 40 table/sequence fingerprints and the journal and bank invariants. The new composite key on journal lines requires measuring write-lock time before a production upgrade. [Restore drill](../testing/restore-drill.md) |
| Performance | On an idle local fixture with 1,000 imported rows and 1,000 outstanding postings, p95 was 19.8 ms for detail and 12.3 ms for duplicate detection. [Measurements](../testing/benchmark-results.md) |

## What is running

The Next.js UI and Fastify/Drizzle API own the ERP workflows. The original TypeScript configuration engine still drives the Configurator. Java/Spring Boot owns deployed VekoScript applications and their PostgreSQL storage. Its Rust worker executes the language with explicit host operations and limits. An HTTP call between these two services has no shared commit boundary. See [platform architecture](../architecture/platform-architecture.md), [extension model](../architecture/vekoscript-extension-model.md) and [module dependencies](module-dependency-map.md).

## Changes and operating limits

- **Historical AR and AP.** Documents, payments, unapplied receipts and reversals now contribute on their business dates, including past-due buckets for paid documents at an earlier cutoff. The existing API routes retain their response shapes. AR records early or excess payments as credits. A vendor payment preceding its bill can produce a negative current bucket. Dashboard widgets and the live open-document lists retain their own current-state semantics.
- **Control reconciliation.** Reports → Control Account Reconciliation displays the AR and AP General Ledger balance, independent subledger balance and signed difference. One read-only repeatable-read transaction supplies the report. Follow each link to the same dated aging report or account ledger. A manual journal affects the GL independently of customer/vendor documents. Cash clearing is available in Bank Reconciliation.
- **Exact display and export.** Currency strings keep their cents through the browser. Journal totals use fixed-point addition. CSV exports retain the selected report date in the filename. The AR credit column keeps its positive magnitude and identifies it as a deduction. Formula-like exported labels are escaped. A blank date hides stale results and exports.
- **Metadata uniqueness.** Spring and Flyway now reconcile the active unique-field definition across create, upgrade and removal. PostgreSQL rolls back an attempted uniqueness change on duplicate data. Deployed rows and unrelated indexes are preserved. Existing application schemas need Flyway V2 when the service upgrades.
- **Books close and journal integrity.** Drizzle 0005 orders journal and stock movements against changes to the organization's closing date, including zero-value inventory activity. It records the actual previous date when a period is partially reopened. Migration 0006 seals the line set of every committed journal. A posting can assemble lines across commands within its original transaction. A later addition to that journal is rejected, including a balanced pair. The backfill locks journal writes during upgrade. Test lock duration on a production-sized restore before scheduling deployment.
- **Account drill-down.** The ledger displays up to 5,000 detail rows and announces when further rows are omitted. The closing balance includes every dated posting in the snapshot. Normal debit/credit sides, future-only accounts and unusually large balances are covered by the fixtures.
- **Studio.** Owners and administrators can open `/studio`, edit application source, check diagnostics, review the storage plan and publish the reviewed version. A conflicting publication preserves the local draft. Viewers can browse published object metadata. Existing API clients can still omit the optional base-version precondition. The original ERP Configurator remains available. [Run Studio](../vekoscript/editor.md)
- **Frontend dependencies.** Next.js is on 16.4.6. The editor build serves a local Monaco bundle and worker with patched DOMPurify. A browser test exercises language completion, diagnostics, save and worker execution.
- **Recovery.** A logical restore of the populated ERP fixture reproduced all table fingerprints and sequence values. CI now includes a restore and production dependency audit. [Restore exercise](../testing/restore-drill.md)

## Verification record

| Run | Result | Scope |
| --- | --- | --- |
| Baseline Fastify | 107 passed, 0 failed | Existing nine suites on a disposable PostgreSQL 18 cluster, including working-copy gateway tests. The older README reported only 66. |
| Baseline Java / Rust | 7 / 56 passed | Java used PostgreSQL and a real release worker. |
| Baseline browser / types | Browser launch initially failed because the pinned Chromium shell was absent. Web typecheck reported two implicit parameter types in the Monaco callback. | Installed the matching browser and resolved the editor types from its package export. A transient dev-server restart also interrupted one mobile run. |
| Historical finance implementation | 19 of the first 24 aging cases failed with the old queries. All 134 API tests then passed, including reconciliation under concurrent posting. | Real journal/party/stock records, tenant scoping, invalid dates, inclusive reversal, advances and control variances. |
| ERP/API suite before the bank increment | **144 passed, 0 failed, 12 test files** on a newly created PostgreSQL 18.6 database. API and web typecheck and optimized builds passed. | Includes concurrent close and reopen, zero-value inventory rollback, sealed journal lines, populated migration replay, 5,001-line drill-down and turnover above a single entry's numeric precision. |
| Runtime and Studio | 11 Java and 56 Rust tests passed. Rustfmt and Clippy passed. One separate Studio browser journey passed with two clean axe scans. | Real Fastify session, Spring, PostgreSQL 18.6, Rust worker, Monaco and Chromium. Owner, viewer, stale-draft conflict and destructive-plan approval in an isolated application. |
| Browser finance and UI | 6 passed on the production build, including original order-to-cash, procure-to-pay, mobile navigation, independent Monaco smoke and the new month-end journey. | Chromium, Playwright, axe scans. A real browser exposed a reconciliation drill-down hit-target issue during implementation. The corrected link passes a normal pointer click. |
| Performance | With 0005 and 0006 active, AR 25.8 ms, AP 4.8 ms, reconciliation 55.4 ms p95 at 1,110 invoices and 9,067 journal lines. | Single caller, real PostgreSQL, 50 samples per read. [Benchmarks](../testing/benchmark-results.md) |
| Build and design | Production builds and typecheck passed. Both token palettes passed 24 declared contrast checks each. | Local Windows build and Chromium. Manual screen-reader and cross-browser reviews remain open. |
| Restore and upgrade | Before the seal migration, 37 fingerprints matched. With 0006 active, all 38 matched, including 2,319 seals. All 2,319 journal entries remained balanced. The populated 0004 → 0006 upgrade and migration replay preserved the original journal data. | Separate source, upgrade and restore databases on a disposable PostgreSQL cluster. |
| Dependency audit and CI | `npm audit --omit=dev` returned zero known advisories for the preceding increment. | This repository runs the [ERP](../../.github/workflows/ci.yml) and [VekoScript](../../.github/workflows/vekoscript.yml) checks on pushes to main. |

Financial acceptance for the month-end scenario earns **13/13** weighted points (M1–M6). Bank reconciliation and grouped deposits each earn **14/14** (B01–B05 and D01–D05). The [acceptance criteria](../testing/ecosystem-acceptance-criteria.md) define the assertions. The [ecosystem matrix](1c-functional-parity.md) tracks 262 capabilities, with 47 TESTED, 10 IMPLEMENTED, 1 DESIGNED, 3 RESEARCHED and 201 NOT STARTED. The [Replica inventory](../../replica/parity-score.md) scores 70.0/100 on its smaller release feature list.

## Resume and verify

1. Read this checkpoint and review `git status --short --branch`. Check the matrix risk and next-action columns before selecting a new scope.
2. Provision separate disposable PostgreSQL databases for the ERP API tests, ERP browser fixtures and Java integration tests. The Fastify harness empties its test database. Set `TEST_DATABASE_URL` for API tests, `DATABASE_URL` for browser migrations and API service, and `VKS_TEST_DB_URL`, `VKS_DB_USER`, `VKS_DB_PASSWORD` for Java tests. Keep benchmark and restore destinations separate.
3. Run `npm ci`, `npm run db:migrate`, `npm run typecheck`, `npm test`, `npm run build`, `npx playwright install chromium` and `npm run test:e2e`. Run `cargo test --workspace` and `cargo build --release -p vks-cli` in `engine/vekoscript`, followed by `./mvnw test` (Windows `mvnw.cmd test`) in `backend`.
4. Start Spring with the release worker and the same locally generated `VKS_JWT_SECRET` as Fastify. With Next and the API running, execute `npm run test:studio -w @4veko/web`. The [Studio guide](../vekoscript/editor.md) and [CI job](../../.github/workflows/vekoscript.yml) show the environment and ports.
5. Run `npm audit --omit=dev`. Use the [restore drill](../testing/restore-drill.md) against the disposable fixture and the [performance procedure](../testing/benchmark-results.md) for material changes to posting or reporting.

## Remaining release work

The next core ERP milestone is a customer credit memo for a partial return against an original invoice. Preserve the quantity and tax of the unaffected lines. Trace each financial and stock correction to its source, reject repeated or excessive returns, and reconcile the customer's credit to dated AR and the general ledger. Live bank feeds and OFX imports remain separate work.

Independent accounting and US tax review, production backups and point-in-time recovery, cross-service financial posting, packaged extension upgrades, larger concurrent workloads and external deployment evidence remain open. The browser, database and runtime evidence here covers the specified scenarios. It does not establish full 1C ecosystem parity or production approval.
