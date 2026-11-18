# Release feature inventory

This score covers the rows and priorities in [features.csv](features.csv). The [ecosystem matrix](../docs/product/1c-functional-parity.md) and [financial acceptance gates](../docs/testing/ecosystem-acceptance-criteria.md) track the broader mission. The inventory assigns half credit to partial implementations. It measures neither production readiness nor full ecosystem parity.

## Parity: 68.9 / 100

features 68.9  (45 counted, must-haves 18 of 18 done)

## By area, weakest first
- tax                            0.0  (1 features)
- documents                      0.0  (1 features)
- budgeting                      0.0  (1 features)
- assets                         0.0  (1 features)
- manufacturing                  0.0  (2 features)
- crm                            0.0  (1 features)
- hr                             0.0  (1 features)
- payroll                        0.0  (1 features)
- projects                       0.0  (1 features)
- integration                   50.0  (2 features)
- platform                      57.7  (6 features)
- cash                          60.0  (2 features)
- sales                         75.0  (3 features)
- inventory                     77.8  (4 features)
- accounting                    80.0  (7 features)
- reporting                     92.3  (5 features)
- onboarding                   100.0  (1 features)
- master data                  100.0  (3 features)
- procurement                  100.0  (2 features)

## Missing, in build order
- [should] cash: Bank reconciliation and bank import, no  (bank exchange (S13))
- [should] documents: Document attachments, no  (document management product (S11))
- [should] platform: Approval workflows and spending limits, no  (payment limits (S4))
- [should] platform: Custom fields on records, no  (configuration objects low-code (S5))
- [should] sales: Partial invoicing credit notes and quotes, no  (inferred standard practice)
- [should] tax: Sales tax by jurisdiction, no  (tax calculation (S15) for Russian regimes; US engine via integration)
- [should] integration: CSV import and export, partial  (CSV export on reports only; no import)
- [should] integration: REST API with OpenAPI and webhooks, partial  (REST + OpenAPI at /api/docs done; webhooks and API keys not built)
- [should] inventory: Multiple warehouses and transfers, partial  (schema and API support locations; UI uses one default warehouse; no transfers yet)
- [should] platform: Mobile-friendly access, partial  (responsive web tested at phone width; no native app or offline mode)
- [should] reporting: Saved report views and export, partial  (saved table views (per browser) and report CSV/print; no server-side saved reports)
- [could] accounting: Consolidation and eliminations, no  (1C:Perform (S9))
- [could] accounting: Multi-currency documents, no  (scenario currencies (S4))
- [could] accounting: Multiple companies and intercompany, no  (intercompany (S3 S16))
- [could] assets: Fixed asset register and depreciation, no  (asset dimensions (S3))
- [could] budgeting: Budgets and plan versus actual, no  (budgeting (S4))
- [could] crm: Leads and sales pipeline, no  (pipeline (S7))
- [could] hr: Employee records, no  (HR records (S18))
- [could] inventory: FIFO lots batches and serials, no  (lot accounting FIFO (S3) batch reports (S2))
- [could] manufacturing: Bills of materials and work orders, no  (production subsystem (S2 S8))
- [could] manufacturing: Production scheduling and MES, no  (MES (S2))
- [could] payroll: Payroll processing, no  (payroll (S18); US payroll via provider integration first)
- [could] projects: Projects and job costing, no  (work tasks and acts (S17))
- [could] platform: Proprietary scripting language and IDE, partial  (Rust language and Java host; Studio check and versioned publish tested in Chromium; form designer and isolated candidate environments pending)

## Left out on purpose (not scored)
- Russian statutory reporting and e-filing: not relevant to the US market

## Yours, not in the original (not scored)
- Global search and command palette
- AI assistant for reports and search
