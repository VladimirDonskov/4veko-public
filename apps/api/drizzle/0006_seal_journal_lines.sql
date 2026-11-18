CREATE TABLE "journal_entry_seals" (
	"organization_id" uuid NOT NULL,
	"journal_entry_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
-- Hold off new posts while existing headers are marked as complete.
LOCK TABLE journal_entries, journal_lines IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "journal_entry_seals" ADD CONSTRAINT "seal_entry_fk" FOREIGN KEY ("organization_id","journal_entry_id") REFERENCES "public"."journal_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO journal_entry_seals (organization_id, journal_entry_id)
  SELECT organization_id, id FROM journal_entries;
--> statement-breakpoint
CREATE TRIGGER journal_entry_seals_immutable
  BEFORE UPDATE OR DELETE ON journal_entry_seals
  FOR EACH ROW EXECUTE FUNCTION veko_reject_change();
--> statement-breakpoint
CREATE FUNCTION veko_seal_journal_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO journal_entry_seals (organization_id, journal_entry_id)
    VALUES (NEW.organization_id, NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_seal_lines
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION veko_seal_journal_lines();
--> statement-breakpoint
CREATE FUNCTION veko_require_unsealed_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sealed boolean;
BEGIN
  -- The header and its seal become visible to other transactions together.
  -- Require a visible parent as well as an absent seal, even when a second
  -- transaction is concurrently constructing an entry with the same ID.
  SELECT s.journal_entry_id IS NOT NULL INTO sealed
    FROM journal_entries e LEFT JOIN journal_entry_seals s ON s.journal_entry_id = e.id
    WHERE e.organization_id = NEW.organization_id AND e.id = NEW.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry does not exist in this organization' USING ERRCODE = '23503';
  END IF;
  IF sealed THEN
    RAISE EXCEPTION 'The lines of posted journal entry % are sealed; use a reversal or adjustment', NEW.journal_entry_id
      USING ERRCODE = 'VK001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_require_unsealed_entry
  BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION veko_require_unsealed_entry();
--> statement-breakpoint
-- The deferred entry trigger is queued when the header is inserted, before
-- this foreign key is checked for its lines. Requiring the seal at commit
-- also prevents removing the seal table's contents independently of the ledger.
ALTER TABLE journal_lines ADD CONSTRAINT jl_seal_fk FOREIGN KEY (journal_entry_id)
  REFERENCES journal_entry_seals (journal_entry_id) DEFERRABLE INITIALLY DEFERRED;
