# Ecosystem acceptance criteria

Use these gates alongside the [capability matrix](../product/1c-functional-parity.md) and the [run record](../product/implementation-progress.md). Record the revision, fixture, command, assertion and outcome. A passing ledger unit test alone grants no credit for an untested browser, migration or operational gate.

## Weights and status

Count a gate once for its specific scenario. Weight **3** covers financial, data-loss and tenant-boundary failures. Weight **2** covers complete user journeys and recovery. Weight **1** covers presentation and performance checks. A failed weight-3 gate blocks the affected release regardless of its weighted score. Split a broad capability into separately testable outcomes before assigning TESTED. Record the earned and possible points **within each named scenario**. Additional business domains introduce new scenarios and must have their own denominators.

## Month-end receivables and payables

| Gate | Weight | Required observation | Repeatable evidence |
| --- | ---: | --- | --- |
| M1 Dated obligations | 3 | Before issue, on the due date, after partial or full settlement and after void, each signed party balance agrees with the independent control-account fixture. Include a backdated payment allocated to a future document, an overpayment and all five aging buckets. | `apps/api/test/historical-aging.test.ts` |
| M2 Discrepancies | 3 | A manual GL posting moves the control account independently of the subledger. Both positive and negative differences appear on the correct date and clear on the reversal date. Repeated concurrent reads cannot observe half a posting. | Same API suite, control reconciliation cases |
| M3 Access | 3 | A second tenant sees only its own control accounts and documents. An anonymous request is rejected. A viewer can read an empty report without changing financial state. | Same API suite, organization and viewer cases |
| M4 Bookkeeper workflow | 2 | After the invoice and bill are paid, recover the month-end balances through Reports. Follow links to both aging reports and the dated account ledger. Reload the report and inspect the original journal entry. | `apps/web/e2e/period-close.spec.ts` |
| M5 Presentation and export | 1 | UI and CSV preserve the selected date and the full cent amount. Clearing the date removes stale export actions. The reconciliation table has readable column headers and a text label for differences. Run the Chromium accessibility scan. | Same browser suite plus light/dark token checks |
| M6 Response time | 1 | For each aging endpoint and the control report, p95 is below the existing 150 ms read target on the named synthetic workload. Record version, row counts, samples and timings. | `apps/api/scripts/bench.ts` and [benchmark results](benchmark-results.md) |

## Bank statement reconciliation

| Gate | Weight | Required observation | Repeatable evidence |
| --- | ---: | --- | --- |
| B01 First statement and import | 3 | The opening bank balance ties to the book balance before the first period. Prior postings are treated as cleared. Opening plus signed transactions equals the closing bank balance. Repeated or concurrent imports of identical content persist one statement. A reused reference with changed content is rejected. | [Bank API fixture](../../apps/api/test/bank-reconciliation.test.ts) |
| B02 Matching and outstanding items | 3 | Each bank transaction clears exactly one posting of equal signed amount on the same bank account through period end. An outstanding check reduces the adjusted bank balance. Clearing it next month preserves its outstanding status in the earlier period. The journal count and source payments are unchanged. | Bank API fixture, cross-period check and customer/vendor payments |
| B03 Close and correction | 3 | Closing requires zero unmatched bank rows, zero discrepancy and all earlier statements closed. Equal but opposite unmatched rows still block close. Closing freezes the approved figures for comparison with any subsequent backdated postings. Later statements carry the previous closing balance. Reopening follows reverse chronological order. Only the newest open, fully unmatched import can be discarded. | Bank API fixture, close and correction cases |
| B04 Access and audit | 3 | Organization and bank-account references are enforced for reads, imports and matches. A viewer has read access, an accountant can clear and close, and an owner or admin can reopen. Successful mutations record the actor and statement. | Bank API fixture and [migration constraints](../../apps/api/test/migrations.test.ts) |
| B05 Bookkeeper workflow | 2 | Import a CSV, inspect the deposit and outstanding check, match and unmatch, close, reopen and close again. Replay the import, clear the check next month and inspect a later backdated posting alongside the approved balance. Check phone-width layout, accessibility and read-only viewer controls. | [Browser journey](../../apps/web/e2e/bank-reconciliation.spec.ts) |

The bank scenario passed all five gates (**14/14 weighted points**). See the [run record](../product/implementation-progress.md) for the environment and totals. The adjusted bank balance is the statement closing balance plus the signed outstanding book items. The difference is the book balance through period end minus that adjusted amount. When converting an existing ledger with carry-in items, begin with an earlier period that has a reconciled opening balance. Dedicated opening-outstanding entries, grouped matches and live bank feeds require further work.

## Grouped bank deposits

| Gate | Weight | Required observation | Repeatable evidence |
| --- | ---: | --- | --- |
| D01 Receipt and ledger totals | 3 | Select posted receipts held in Undeposited Funds by the deposit date. A single debit to the bank and credit to clearing equal the full receipts. Original invoice applications, unapplied credit and payment journals remain intact. Reject a total exceeding journal precision. | [Deposit API suite](../../apps/api/test/deposits.test.ts) |
| D02 Retries and competing claims | 3 | Replaying the same request creates one deposit, journal and posting audit event. Changing the request under that key fails. When two requests share a receipt, only one posts and the remaining receipts from the losing request remain available. | Deposit API suite, simultaneous requests |
| D03 Correction and clearing | 3 | A dated void posts a linked reversal and releases receipts on its effective date. Closed books reject posting and reversal. An existing statement match prevents voiding. On an earlier cutoff an outstanding deposit remains visible. Once effective, the void offsets the original. | Deposit API suite, void and matching races |
| D04 Isolation and upgrade | 3 | Foreign receipts, bank accounts and documents cannot enter another tenant's deposit. A viewer can inspect a deposit. Posting and correction require bank reconciliation permission. Upgrade from 0007 preserves original receipts and journals, and the database rejects a second active claim. | Deposit API suite and [migration fixture](../../apps/api/test/migrations.test.ts) |
| D05 Bookkeeper journey | 2 | Review two receipts and their total, post, void with a reason and redeposit. Follow the receipt history, match a single bank transaction to the replacement and close the statement. Inspect the deposit on a phone viewport and check read-only access. | [Browser journey](../../apps/web/e2e/deposits.spec.ts) |

The [engineering checkpoint](../product/implementation-progress.md) records the verified environment and result for these gates.

## Other release gates

| Scenario | Weight-3 financial or isolation gate | Weight-2 workflow/recovery gate | Outstanding evidence for release |
| --- | --- | --- | --- |
| Order to cash | Invoice posts receivable, revenue, tax, COGS and stock together. Concurrent invoice retries post once. A reversal restores stock and GL at original value. | Create a customer and product, issue, pay and trace the entry and dashboard through the public UI. | Independent accounting review, larger-volume and recovery evidence. |
| Procure to pay | Concurrent receipts cannot exceed ordered quantity. Billing cannot exceed receipts. Price variance and cash movements reconcile against AP and accrual. | Issue a PO, partially receive, enter the vendor bill and pay it. Reject a duplicate vendor invoice. The bank fixture clears the posted bill payment. | Controlled vendor returns and credits, payment transmission and deployment recovery evidence. |
| Inventory and close | Closed dates reject stock and GL effects including a zero-value movement. Closure racing a posting either waits for the earlier transaction or rejects the later posting. Verify complete rollback. | Reopen with authorization and audit. Post on the next open day. | Multi-warehouse physical stocktake against the GL and reconciliation after restore. |
| Metadata deployment | A failed schema upgrade leaves version, definitions, uniqueness, tenant data and permissions intact. A deployed application cannot write another tenant's records. | Deploy a catalog, enter records, upgrade supported fields and retry a failed upgrade. Verify behavior for pre-upgrade records. | Package compatibility, distribution, signing and recovery rehearsal. |
| Scripted document | Fixed-point values, host grants and lifecycle operations are verified in the Rust worker and real Java/PostgreSQL host. A rejected handler rolls back writes, audit effects and outbox effects from the operation. | Create, post and reverse a document in a deployed application. Recover after worker timeout. | Shared ERP posting contract and a browser-to-worker authoring journey. |
| Manufacturing | Issue inputs, account for WIP and variances, receive finished goods and reconcile all inventory value to GL. | Follow an approved BOM through consumption, completion, scrap and traceability. | A real source-linked production order and financial fixtures. |
| Payroll | Rules are effective-dated and jurisdiction-scoped. Independent reviewed fixtures cover rounding, deductions, historical replay and reversal. | Review and approve a pay run and reconcile its authorized journal. | Rules review, provider validation and explicit authorization for live processing. |
| Operations and recovery | Restore a backup to an isolated database, then reconcile tenant counts, document links, stock and opening/closing balances. The [ERP fixture drill](restore-drill.md) compares all table contents, sequences and journal balance. | Measure recovery time and data loss against approved RTO/RPO. Rehearse migration failure and service restart. | Platform storage, roles, secrets, archived WAL and disaster-recovery drill on the deployment candidate. |

For each additional capability in domains A–R, follow its matrix dependency and next action. Define a named business fixture, expected durable records, permissions, failure rollback and source report. For external providers, record sandbox request IDs and reconciliation results. Production validation needs independent business sign-off, operational controls and evidence from the specific deployed version.
