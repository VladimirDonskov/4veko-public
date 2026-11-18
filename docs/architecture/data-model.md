# Data model

Drizzle `0005` serializes ERP journal and stock insertion against an organization period close. Migration `0006` backfills one immutable seal per historical journal entry and adds deferred enforcement for new entries. A transaction may assemble its journal lines before commit. Subsequent transactions must post a reversal or adjustment. See the [current platform architecture](platform-architecture.md) for the separate Java application schemas and [engineering checkpoint](../product/implementation-progress.md) for upgrade and restore evidence.

Source of truth: `apps/api/src/db/schema.ts` (Drizzle) and the SQL migrations in
`apps/api/drizzle/`. Schema 0006 has 34 public ERP tables plus the Drizzle migration ledger.
Compose uses PostgreSQL 17 and the November local test suite used PostgreSQL 18.6. This model is our own design from
standard double-entry accounting practice; it is not derived from any 1C schema.

## Conventions

- Primary keys are UUIDs (`gen_random_uuid()`), except `audit_events` (bigserial, for cheap ordering).
- Every tenant table has `organization_id`. Every reference between tenant tables is a
  **composite foreign key** `(organization_id, x_id) → x(organization_id, id)`, so a row
  can never point at another organization's record, whatever the application does.
- Money: `numeric(18,2)`. Quantities: `numeric(18,4)`. Rates: `numeric(7,4)`. Never floats.
- Dates of business events are `date` (no time zone); audit times are `timestamptz`.
- Documents carry a human number (`INV-1001`) from a per-organization, gap-free sequence
  (`number_sequences`, row-locked upsert).

## Entities

```
organizations ─┬─ memberships ── users ── sessions
               ├─ accounts (Chart of Accounts, system_key for AR, inventory, tax…)
               ├─ parties (kind = customer | vendor)
               ├─ items (inventory | non_inventory | service) → income/COGS/inventory accounts
               ├─ locations (warehouses; one default)
               ├─ journal_entries ── journal_lines → accounts, parties
               ├─ sales_orders ── sales_order_lines → items
               ├─ invoices ── invoice_lines → items, income account
               │     └─ payment_applications ── payments → deposit account
               ├─ stock_levels (item × location: qty_on_hand, value_on_hand)
               ├─ stock_moves (signed qty and value per source document)
               ├─ inventory_adjustments ── inventory_adjustment_lines
               ├─ purchase_orders ── purchase_order_lines (qty ordered / received / billed)
               │     └─ purchase_receipts ── purchase_receipt_lines
               ├─ bills ── bill_lines (order line + qty + cost, or account + amount)
               │     └─ bill_payment_applications ── bill_payments → bank account
               ├─ number_sequences
               └─ audit_events (append-only)
```

## How documents post

| Document | Journal entry | Stock |
| --- | --- | --- |
| Invoice | Dr Accounts Receivable (total, with customer) · Cr income account per line · Cr Sales Tax Payable · Dr COGS / Cr Inventory at moving-average cost | issue at moving average |
| Invoice void | exact reversal of the invoice entry, linked both ways | receive back at the original cost |
| Payment | Dr deposit account (Undeposited Funds by default) · Cr Accounts Receivable (with customer) | – |
| Inventory adjustment (+) | Dr Inventory · Cr offset (Opening Balance Equity, AP, cash…) | receive at entered cost |
| Inventory adjustment (−) | Dr offset (Shrinkage by default) · Cr Inventory | issue at moving average |
| Purchase receipt | Dr Inventory (order cost) · Cr Received Not Billed (with vendor) | receive at order cost |
| Vendor bill | Dr Received Not Billed (order cost of billed qty) · Dr/Cr Purchase Price Variance (bill − order cost) · Dr expense/asset accounts for expense lines · Cr Accounts Payable (total, with vendor) | – |
| Bill void | exact reversal; order lines' billed quantity restored | – |
| Bill payment | Dr Accounts Payable (with vendor) · Cr bank account | – |
| Manual entry | as entered (balanced) | – |
| Reversal | every line swapped; original gets `reversed_by_id` | – |

## Invariants and where they are enforced

| Invariant | Application | Database |
| --- | --- | --- |
| Debits = credits per entry, ≥ 2 lines | `postJournalEntry` | deferred constraint triggers `journal_lines_balanced`, `journal_entries_have_lines` |
| A line is debit-only or credit-only, non-negative | `postJournalEntry` | check `jl_amounts_ck` |
| Posted lines/entries cannot change or be deleted | no update paths | triggers `journal_lines_immutable`, `journal_entries_no_delete`, `journal_entries_guard_update` (only `reversed_by_id` may be set, once) |
| No posting on/before the books-closed date | `postJournalEntry` | trigger `journal_entries_period_open` |
| Audit history is append-only | no update paths | trigger `audit_events_immutable` |
| No cross-tenant references | queries scoped by org | composite foreign keys |
| Stock never negative; empty stock has zero value | `issueStock` with row lock | checks `stock_nonneg_ck`, `stock_empty_value_ck` |
| An invoice's paid amount ≤ total; balance = total − paid | `recordPayment` with row locks | check `inv_amounts_ck` |
| A sales order has at most one non-void invoice | row lock on the order | partial unique index `inv_sales_order_active_uq` |
| A retried payment is recorded once | lookup by key before and after taking row locks | partial unique indexes `pmt_org_idem_uq`, `bp_org_idem_uq` |
| Never receive more than ordered; never bill more than received | row locks on order and lines | check `pol_qty_ck` |
| A vendor invoice number is entered once per vendor (unless voided) | – | partial unique index `bill_vendor_ref_active_uq` |
| A bill's paid amount ≤ total | row locks on bills | check `bill_amounts_ck` |

Reconciliation invariants verified by tests (`order-to-cash.test.ts`, `purchasing.test.ts`) and on
the seeded data: AR control = open invoice balances − unapplied payments; AP control = open bill
balances; Received Not Billed = Σ (received − billed) × order cost; Inventory account =
Σ `stock_levels.value_on_hand`; trial balance and balance sheet balance.

New system accounts in Release 0.2 (backfilled for existing organizations by migration 0003):
2050 Received Not Billed (liability) and 5200 Purchase Price Variance (cost of goods sold).
Price variance is expensed rather than capitalized into inventory, a deliberate simplification
for moving-average costing; an accountant should confirm it suits each business.

## Not yet modelled (see roadmap)

Receipt reversals and vendor credits; bank accounts and reconciliation; multi-currency;
multiple companies per tenant; custom fields (planned as JSONB validated against definitions);
attachments; FIFO cost layers; webhooks and API keys.
