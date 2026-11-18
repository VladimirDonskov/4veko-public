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

## Other release gates

| Scenario | Weight-3 financial or isolation gate | Weight-2 workflow/recovery gate | Outstanding evidence for release |
| --- | --- | --- | --- |
| Order to cash | Invoice posts receivable, revenue, tax, COGS and stock together. Concurrent invoice retries post once. A reversal restores stock and GL at original value. | Create a customer and product, issue, pay and trace the entry and dashboard through the public UI. | Independent accounting review, larger-volume and recovery evidence. |
| Procure to pay | Concurrent receipts cannot exceed ordered quantity. Billing cannot exceed receipts. Price variance and cash movements reconcile against AP and accrual. | Issue a PO, partially receive, enter the vendor bill and pay it. Reject a duplicate vendor invoice. | Controlled vendor returns and credits, bank statement matching, recovery evidence. |
| Inventory and close | Closed dates reject stock and GL effects including a zero-value movement. Closure racing a posting either waits for the earlier transaction or rejects the later posting. Verify complete rollback. | Reopen with authorization and audit. Post on the next open day. | Multi-warehouse physical stocktake against the GL and reconciliation after restore. |
| Metadata deployment | A failed schema upgrade leaves version, definitions, uniqueness, tenant data and permissions intact. A deployed application cannot write another tenant's records. | Deploy a catalog, enter records, upgrade supported fields and retry a failed upgrade. Verify behavior for pre-upgrade records. | Package compatibility, distribution, signing and recovery rehearsal. |
| Scripted document | Fixed-point values, host grants and lifecycle operations are verified in the Rust worker and real Java/PostgreSQL host. A rejected handler rolls back writes, audit effects and outbox effects from the operation. | Create, post and reverse a document in a deployed application. Recover after worker timeout. | Shared ERP posting contract and a browser-to-worker authoring journey. |
| Manufacturing | Issue inputs, account for WIP and variances, receive finished goods and reconcile all inventory value to GL. | Follow an approved BOM through consumption, completion, scrap and traceability. | A real source-linked production order and financial fixtures. |
| Payroll | Rules are effective-dated and jurisdiction-scoped. Independent reviewed fixtures cover rounding, deductions, historical replay and reversal. | Review and approve a pay run and reconcile its authorized journal. | Rules review, provider validation and explicit authorization for live processing. |
| Operations and recovery | Restore a backup to an isolated database, then reconcile tenant counts, document links, stock and opening/closing balances. The [ERP fixture drill](restore-drill.md) compares all table contents, sequences and journal balance. | Measure recovery time and data loss against approved RTO/RPO. Rehearse migration failure and service restart. | Platform storage, roles, secrets, archived WAL and disaster-recovery drill on the deployment candidate. |

For each additional capability in domains A–R, follow its matrix dependency and next action. Define a named business fixture, expected durable records, permissions, failure rollback and source report. For external providers, record sandbox request IDs and reconciliation results. Production validation needs independent business sign-off, operational controls and evidence from the specific deployed version.
