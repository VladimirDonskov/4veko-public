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
END $check$;
COMMIT;
