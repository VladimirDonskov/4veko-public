-- Run with psql -X -qAt -v ON_ERROR_STOP=1 against the quiescent ERP fixture
-- and the restored database. Compare the complete output byte for byte.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

-- Include empty relations, repeated values and every column, including JSON
-- configuration and document links. Sorting removes physical insertion order.
SELECT format(
  $command$
    SELECT %L, count(*),
           md5(coalesce(string_agg(row_hash, '' ORDER BY row_hash COLLATE "C"), ''))
    FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM %I.%I t) AS fingerprints
  $command$, schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, tablename
\gexec

SELECT format('SELECT %L, last_value, is_called FROM %I.%I',
              schemaname || '.' || sequencename, schemaname, sequencename)
FROM pg_sequences
WHERE schemaname IN ('public', 'drizzle')
ORDER BY schemaname, sequencename
\gexec

-- Return nonzero from psql on a broken posting, even if present in both copies.
DO $check$
BEGIN
  IF EXISTS (
    SELECT e.id FROM journal_entries e LEFT JOIN journal_lines l
      ON l.organization_id = e.organization_id AND l.journal_entry_id = e.id
    GROUP BY e.id HAVING count(l.id) < 2 OR sum(l.debit) <> sum(l.credit)
  ) THEN RAISE EXCEPTION 'Invalid journal entry in restore fixture';
  END IF;

  IF to_regclass('public.bank_statements') IS NOT NULL THEN
    IF EXISTS (
      SELECT s.id FROM bank_statements s LEFT JOIN bank_statement_lines l
        ON l.organization_id = s.organization_id AND l.statement_id = s.id
      GROUP BY s.id
      HAVING s.opening_balance + coalesce(sum(l.amount), 0) <> s.closing_balance
        OR bool_or(l.date NOT BETWEEN s.start_date AND s.end_date)
        OR (s.status = 'closed' AND count(l.id) <> count(l.journal_line_id))
    ) THEN RAISE EXCEPTION 'Invalid imported or closed bank statement in restore fixture'; END IF;
    IF EXISTS (
      SELECT 1 FROM bank_statement_lines l
      JOIN journal_lines j ON j.id = l.journal_line_id
      WHERE l.amount <> j.debit - j.credit
         OR l.organization_id <> j.organization_id OR l.account_id <> j.account_id
    ) THEN RAISE EXCEPTION 'Invalid bank-to-journal match in restore fixture'; END IF;
  END IF;

  IF to_regclass('public.deposits') IS NOT NULL THEN
    IF EXISTS (
      SELECT d.id FROM deposits d
      JOIN accounts h ON h.organization_id = d.organization_id AND h.system_key = 'undeposited_funds'
      LEFT JOIN deposit_payments dp ON dp.organization_id = d.organization_id AND dp.deposit_id = d.id
      LEFT JOIN payments p ON p.organization_id = d.organization_id AND p.id = dp.payment_id
      GROUP BY d.id
      HAVING count(p.id) = 0 OR sum(p.amount) <> d.amount
        OR bool_or(p.date > d.date OR p.deposit_account_id <> h.id OR p.journal_entry_id IS NULL)
        OR bool_or(dp.released_on IS DISTINCT FROM d.void_date)
    ) THEN RAISE EXCEPTION 'Invalid deposit receipts or release dates in restore fixture'; END IF;

    IF EXISTS (
      SELECT d.id FROM deposits d
      CROSS JOIN LATERAL (VALUES (d.journal_entry_id, false), (d.void_journal_entry_id, true)) x(entry_id, reversing)
      JOIN accounts h ON h.organization_id = d.organization_id AND h.system_key = 'undeposited_funds'
      JOIN journal_entries e ON e.id = x.entry_id AND e.organization_id = d.organization_id
      JOIN journal_lines l ON l.journal_entry_id = e.id AND l.organization_id = d.organization_id
      GROUP BY d.id, x.reversing, e.id
      HAVING e.source_id IS DISTINCT FROM d.id OR e.source_number IS DISTINCT FROM d.number
        OR e.source_type::text <> CASE WHEN x.reversing THEN 'deposit_void' ELSE 'deposit' END
        OR e.date <> CASE WHEN x.reversing THEN d.void_date ELSE d.date END
        OR (x.reversing AND e.reversal_of_id IS DISTINCT FROM d.journal_entry_id)
        OR count(*) <> 2
        OR coalesce(sum(l.debit - l.credit) FILTER (WHERE l.account_id = d.bank_account_id),0)
           <> CASE WHEN x.reversing THEN -d.amount ELSE d.amount END
        OR coalesce(sum(l.credit - l.debit) FILTER (WHERE l.account_id = h.id),0)
           <> CASE WHEN x.reversing THEN -d.amount ELSE d.amount END
    ) THEN RAISE EXCEPTION 'Invalid deposit source or cash movement in restore fixture'; END IF;
  END IF;
END $check$;
COMMIT;
