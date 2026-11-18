# Defect log

Severity: S1 data loss / security / wrong money / core flow blocked · S2 feature broken ·
S3 broken with workaround or visibly wrong · S4 cosmetic. Open S1: **0**. Open S2: **0**.

### BUG-001: Customer balances always showed $0.00
- Severity: S2 · Flow: F01 · Found by: `order-to-cash.test.ts` "keeps an overpayment…"
- Cause: Drizzle renders columns inside `sql``…`` unqualified, so `customer_id = id` in a
  correlated subquery bound to the subquery's own table.
- Status: fixed (explicit aliases and `"parties"."id"`); regression test in place.

### BUG-002: Journal list totals and adjustment values used the same faulty subquery
- Severity: S2 · Flows: F02, F03 · Found by: code review after BUG-001
- Status: fixed; regression tests "lists entries with their correct totals" and
  "lists inventory adjustments with their value".

### BUG-003: Test worker crashed during parallel password hashing
- Severity: S2 · Exit code 0xC0000409 in the native argon2 binding on Windows.
- Status: fixed by switching to scrypt from Node's standard library (no native add-on);
  3 consecutive green runs afterwards.

### BUG-004: Signed-out visit fired ~40 failing API requests before redirecting
- Severity: S3 · Found by: browser network log
- Status: fixed (server-side redirect in `src/proxy.ts`; the shell stops rendering on 401 and
  redirects once); covered by e2e "signed-out visitors are sent to sign in".

### BUG-005: Inline text links distinguishable by color only (WCAG 1.4.1)
- Severity: S3 · Found by: axe in e2e · Status: fixed (links in running text are underlined).

### BUG-006: Search button accessible name did not contain its visible text (WCAG 2.5.3)
- Severity: S3 · Found by: axe in e2e · Status: fixed.

### BUG-007: Reversing a reversal returned a misleading message
- Severity: S4 · Found by: `ledger.test.ts` · Status: fixed (409 "cannot itself be reversed").

### BUG-008: Concurrent retries with one idempotency key could return an error instead of the original payment
- Severity: S3 (no double payment was possible; the duplicate request failed with 422 instead of replaying)
- Found by: `purchasing.test.ts` (3 simultaneous bill payments with the same key)
- Cause: the key was checked before waiting on row locks; after the first request committed, the second saw the bill already paid.
- Status: fixed in bill payments and customer payments (key re-checked after the locks); regression tests in both suites.

### Demo data showed negative cash and a large loss
- Severity: S4 (seed only) · Status: fixed (full-year sales, monthly restocks and deposits).

## Open (known limitations, not defects in tested behaviour)

| ID | Severity | Description |
| --- | --- | --- |
| LIM-1 | S3 | "Today" uses the server's local date; organizations have no time zone yet |
| LIM-3 | S3 | Login rate limit is in-memory per API instance |
| LIM-4 | S3 | New members get an admin-set temporary password; no invitation, reset or forced change |
| LIM-5 | S4 | Saved table views live in the browser only |

## November 18 financial reporting regressions

| ID | Scenario and observed failure | Correction and evidence |
| --- | --- | --- |
| LIM-2 | Enter a dated bill or invoice, settle it in a later month and inspect the earlier cutoff. The amount disappeared from aging. Nineteen of the 24 targeted assertions failed against the original queries. | Net dated document, reversal and settlement movements in one report snapshot. `historical-aging.test.ts` covers credits, settlements, five buckets and second-tenant access. |
| LIM-6 | Binary floating-point display and accumulation could discard valid cents on high-value journals. | Use the existing fixed-point helpers for journal totals and pass decimal strings directly to the currency formatter. The high-value document and ledger assertions live in `period-close.spec.ts`. |

## November 18 bank reconciliation regressions

| ID | Severity | Reproduction and correction |
| --- | --- | --- |
| BANK-1 | S2, fixed | A bodyless request to remove a match returned HTTP 400. The API accepts an absent body and also checks the expected journal line when supplied. The bank tests exercise both forms. |
| BANK-2 | S2, fixed | A valid 1,000-line statement with 500 multibyte characters per description returned HTTP 413. The import route now accepts the JSON representation of the full supported statement. The regression imports it twice and checks the maximum row count. |
