-- A closing transaction and a posting must agree on their order. Shared
-- row locks allow concurrent postings while ordering them against a close.
CREATE OR REPLACE FUNCTION veko_check_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed_through date;
BEGIN
  SELECT books_closed_through INTO closed_through
    FROM organizations WHERE id = NEW.organization_id FOR SHARE;
  IF NEW.date <= closed_through THEN
    RAISE EXCEPTION 'The books are closed through %; transactions dated % cannot be posted', closed_through, NEW.date
      USING ERRCODE = 'VK003';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_moves_period_open
  BEFORE INSERT ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION veko_check_period_open();
