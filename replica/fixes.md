# Fixes and angle (replica-entrepreneur)

Sample: **9 public comments from 1 source (Hacker News)**, mostly developers discussing 1C's
built-in language. `reviews.py` marks every theme thin. G2, Capterra, TrustRadius and Software
Advice refused automated reading (HTTP 403). **This is not evidence of what 1C customers hate,
and none of it may be used in marketing.** See `replica/feedback.md` and `replica/reviews.csv`.

## Three lists (honest state)

1. **What they hate:** not established. The only recurring theme (5 of 9 comments) is dislike of
   the proprietary scripting language, from developers, not end users.
2. **What is missing:** not established from reviews.
3. **What is unsolved (from the product pages, not reviews):** the Russian line splits
   operational apps from the accounting app (S16, S17 state the hand-off); 1C:ERP is
   partner-implemented over months (S1). These are hypotheses about US buyers to test in
   interviews, not user complaints.

## Fix plan (hypothesis-driven, to validate)

| # | Change | Size | Evidence |
| --- | --- | --- | --- |
| 1 | One system of record: documents and GL in one transaction | done | S16, S17 (hand-off stated) |
| 2 | Self-serve signup with a ready US chart of accounts | done | S1, S6 (partner implementation stated) |
| 3 | Customization through custom fields + REST/webhooks in mainstream languages | L | S5; weak signal from 5 HN comments |
| 4 | Keyboard-first UI with visible ledger impact | done | our design hypothesis; to measure with users |

## Angle (draft, for validation, not for publication)

For US small businesses that outgrow entry-level bookkeeping but do not want a months-long ERP
implementation, 4VEKO keeps sales, stock and the General Ledger in one system you can set up
yourself in an afternoon. Evidence: product-page facts S1, S16, S17; no review evidence yet.

## Next research step

Collect 100+ end-user reviews by hand (browser, human pace) across G2, Capterra, Reddit for
1C:Drive / 1C:ERP **and** for the US alternatives buyers actually compare (QuickBooks Online
Advanced, Odoo, NetSuite, SAP Business One), then re-run `reviews.py`.
