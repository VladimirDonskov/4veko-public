-- Ledger integrity rules enforced by the database, so they hold for every
-- code path (API, scripts, future modules). SQLSTATE codes VK001-VK004 are
-- mapped to API errors in src/lib/errors.ts.

-- 1. Every journal entry balances (checked at commit, after all lines exist).
CREATE OR REPLACE FUNCTION veko_check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_id uuid;
  total_debit numeric;
  total_credit numeric;
  line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    entry_id := NEW.id;
  ELSE
    entry_id := NEW.journal_entry_id;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines WHERE journal_entry_id = entry_id;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % needs at least two lines', entry_id USING ERRCODE = 'VK002';
  END IF;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is not balanced: debits % <> credits %', entry_id, total_debit, total_credit
      USING ERRCODE = 'VK002';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION veko_check_entry_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_have_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION veko_check_entry_balanced();
--> statement-breakpoint

-- 2. Posted lines are immutable. Corrections are reversing entries.
CREATE OR REPLACE FUNCTION veko_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'VK001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION veko_reject_change();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_delete
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION veko_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION veko_reject_change();
--> statement-breakpoint

-- 3. The only allowed change to a posted entry: linking it to its reversal, once.
CREATE OR REPLACE FUNCTION veko_guard_entry_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
     AND (to_jsonb(NEW) - 'reversed_by_id') = (to_jsonb(OLD) - 'reversed_by_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Posted journal entry % is immutable; post a reversing entry instead', OLD.id USING ERRCODE = 'VK001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard_update
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION veko_guard_entry_update();
--> statement-breakpoint

-- 4. No posting on or before the organization's books-closed date.
CREATE OR REPLACE FUNCTION veko_check_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed_through date;
BEGIN
  SELECT books_closed_through INTO closed_through FROM organizations WHERE id = NEW.organization_id;
  IF closed_through IS NOT NULL AND NEW.date <= closed_through THEN
    RAISE EXCEPTION 'The books are closed through %; entries dated % cannot be posted', closed_through, NEW.date
      USING ERRCODE = 'VK003';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION veko_check_period_open();
