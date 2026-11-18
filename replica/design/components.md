# Component specifications

The [design system](../../docs/design/design-system.md) describes the established typography, spacing, palettes and navigation. The active Tailwind mapping and CSS custom properties live in `apps/web/src/app/globals.css`. Both themes use the same semantic roles. The first ecosystem increment reuses these components for month-end review.

| Component | Interaction and states | Where to verify |
| --- | --- | --- |
| Application shell and command palette | Desktop sidebar, mobile menu, skip link and keyboard command search. Active links use the accent role. | `app-shell.tsx`, `command-palette.tsx`, responsive and golden-path browser suites |
| Data table | Search, sorting, facets, keyboard row navigation and local saved views. Empty results and loading have separate render paths. | `data-table.tsx`, customers, inventory |
| Document fields, buttons and dialogs | Native labelled controls, field-level errors, disabled or busy submit, destructive confirmation and focus return. | `ui/inputs.tsx`, `ui/button.tsx`, `ui/dialog.tsx`, document e2e suites |
| Report header and date | A visible “As of” label names the native date control. The URL stores the selected date for sharing and drill-down. Clearing the control prompts for a date. Results and export actions belong to the same completed request. Printed pages carry the business date in the heading description. | AR aging, AP aging, control reconciliation |
| Reconciliation table | One row per control account with a row heading. Decimal amounts align on the right. A signed difference and the text “Review” identify a disagreement. “Matches” denotes zero difference. Underlined links open the ledger or aging report at the same cutoff. On narrow screens the table scrolls inside its card. | `reports/control-reconciliation/page.tsx` and `e2e/period-close.spec.ts` |
| Report actions and feedback | CSV downloads carry the date in their filename. Print uses browser print controls. Loading skeletons occupy the report body. A failed request offers a retry. Zero activity still shows both control accounts. | `report-parts.tsx` and `ui/misc.tsx` |
| Journal detail | Linked account numbers and source documents provide traceability. The debit and credit totals use decimal arithmetic with the same displayed precision as the posting. | `journal/[id]/page.tsx`, period-close browser fixture |
| Studio source review | A labelled editor checks a draft under the selected organization and base revision. Diagnostic buttons jump to the source. Expand each proposed storage change, approve destructive steps and publish. A stale revision offers a way to inspect the intervening source while preserving edits. Read-only members see object metadata. | `studio/`, `components/platform/studio-editor.tsx`, `e2e-platform/studio.spec.ts` |

The contrast check in `replica-design` measures declared foreground/background pairs. Browser accessibility results and pending manual screen-reader checks are recorded in the [acceptance evidence](../../docs/product/implementation-progress.md).
