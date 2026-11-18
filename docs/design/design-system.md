# Design system

An original system for 4VEKO. It borrows no layout, asset or wording from 1C. General
usability references (Linear, Notion, Stripe Dashboard) informed principles only.

## Principles

1. **The ledger is never hidden.** Every document shows the journal entry it posted, and every
   number on the dashboard links to the records behind it.
2. **Keyboard first, mouse friendly.** Ctrl/⌘ K opens search and commands; `/` filters any
   table; ↑/↓ and Enter move through rows; Ctrl/⌘ Enter saves a document.
3. **Fewer screens.** "Save and invoice" turns an order into a posted invoice in one step; a
   payment opened from an invoice is pre-filled; customers can be created inside an order.
4. **Plain US English.** Terms from US practice: Accounts Receivable, General Ledger, Chart of
   Accounts, Sales Orders, Vendors. No translated legacy labels.
5. **Calm density.** 14px base text, tabular numerals for money, warm neutrals, one accent.

## Tokens

Files: `replica/design/tokens.json` (light) and `tokens-dark.json` (dark), wired as CSS custom
properties in `apps/web/src/app/globals.css` and mapped into Tailwind (`bg-surface`,
`text-muted`, `bg-accent`…). Components use roles only, never raw hex.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| bg / surface / surface-2 | #ffffff / #f6f7f5 / #eceee9 | #0f1211 / #161a18 / #1e2321 | page, sidebar and cards, hover |
| text / text-muted | #161a17 / #59615b | #e8ece9 / #a3aca6 | body, secondary |
| accent / on-accent | #0b6e5f / #ffffff | #3dbfa5 / #04201a | primary actions, active nav, chart |
| danger, success, warning, info | #b42318, #1d6f42, #8a5300, #1f5fad | #f97a6c, #5cc98a, #f2b544, #7fb0f0 | status, always with a label or icon |
| border / border-input / focus | #e1e4de / #848b84 / accent | #2b312e / #737c76 / accent | dividers, form controls, focus ring |

**Contrast:** checked with `replica-design/contrast.py` on 24 text/background and UI pairs per
theme: **0 failures at WCAG AA** in light and dark (lowest text pair 5.34:1; input borders
3.50:1 light, 4.37:1 dark).

Type: Inter (SIL Open Font License) via `next/font`, scale 12/13/14/16/20/24/32. Spacing on a
4px grid. Radius 6/8/12. Icons: Lucide (ISC license). Logo: an original geometric "V" mark in
the accent color (`components/app-shell.tsx`); a professional logo is still to be designed.

## Components

| Component | File | Notes |
| --- | --- | --- |
| Button / ButtonLink | `components/ui/button.tsx` | primary, secondary, ghost, danger, link; loading state keeps its label |
| Input, Select, Textarea, Field, FormError | `components/ui/inputs.tsx` | Field wires label, hint and error ids for screen readers; `aria-invalid` styling |
| Card, PageHeader, Badge, StatusBadge, Money, Skeleton, EmptyState, ErrorState | `components/ui/misc.tsx` | Money is tabular and turns negative amounts red; statuses always have text |
| Dialog | `components/ui/dialog.tsx` | Radix Dialog: focus trap, Escape, labelled title and description |
| Toast | `components/ui/toast.tsx` | polite live region; errors use role="alert" |
| DataTable | `components/data-table.tsx` | sort, filter, facet, saved views (per browser), bulk select, keyboard rows, responsive columns |
| Command palette | `components/command-palette.tsx` | cmdk: records from `/search`, actions, navigation |
| DocumentForm | `components/document-form.tsx` | order/invoice editor with exact fixed-point totals preview and stock warnings |
| LedgerImpact | `components/ledger-impact.tsx` | the journal entry behind any document |
| BarChart | `components/bar-chart.tsx` | single series, accent hue, 4px rounded data ends, tooltip per bar, screen-reader table |

## Accessibility (target: WCAG 2.2 AA)

Automated: axe-core runs in the Playwright suite on sign-up, sign-in, empty and filled
dashboard, new sales order, invoice, record payment and trial balance — **0 violations** at
wcag2a/aa, 2.1 a/aa and 2.2 aa. Two real issues were found and fixed this way (color-only
inline links; a search button whose accessible name did not include its visible text).
Not yet done: manual screen-reader testing (NVDA, VoiceOver), full keyboard audit of every
dialog, high-contrast/forced-colors mode, and 200% zoom review.
