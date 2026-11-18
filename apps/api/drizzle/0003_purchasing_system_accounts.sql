-- Purchasing needs two system accounts. New organizations get them from the
-- chart template; this backfills organizations created before Release 0.2.
-- If an organization already uses the number, the account takes the next
-- free "-S" suffixed number so the system key is always present.
INSERT INTO accounts (organization_id, number, name, type, subtype, system_key, description)
SELECT o.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.organization_id = o.id AND a.number = '2050') THEN '2050-S' ELSE '2050' END,
       'Received Not Billed', 'liability', 'other_current_liability', 'received_not_billed',
       'Stock received from vendors whose bill has not been entered yet.'
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.organization_id = o.id AND a.system_key = 'received_not_billed');
--> statement-breakpoint
INSERT INTO accounts (organization_id, number, name, type, subtype, system_key, description)
SELECT o.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.organization_id = o.id AND a.number = '5200') THEN '5200-S' ELSE '5200' END,
       'Purchase Price Variance', 'expense', 'cogs', 'purchase_price_variance',
       'Difference between the purchase order cost and the vendor bill cost.'
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.organization_id = o.id AND a.system_key = 'purchase_price_variance');
