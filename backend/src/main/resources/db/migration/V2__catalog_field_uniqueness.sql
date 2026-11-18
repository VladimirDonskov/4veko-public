-- Earlier releases named the index differently on initial deployment and field upgrades.
-- Reconcile each deployed catalog with its active metadata. Only touch an existing index
-- when its original CREATE statement is in this application's generated DDL history.
DO $migration$
DECLARE
    field record;
    old_name text;
    new_name text;
    kept boolean;
BEGIN
    FOR field IN
        SELECT a.id AS app, a.schema_name AS ns, c->>'name' AS catalog,
               'c_' || (c->>'name') AS tbl, f->>'name' AS name,
               'f_' || (f->>'name') AS col, (f->>'unique')::boolean AS is_unique
        FROM vks_application a
        JOIN vks_application_version v ON (v.application_id, v.version) = (a.id, a.current_version)
        CROSS JOIN jsonb_array_elements(v.metadata->'catalogs') c
        CROSS JOIN jsonb_array_elements(c->'fields') f
    LOOP
        new_name := 'ux_cf_' || md5(field.catalog || '/' || field.name);
        kept := false;
        FOR old_name IN
            SELECT idx.relname
            FROM pg_index i
            JOIN pg_class idx ON idx.oid = i.indexrelid
            JOIN pg_attribute col ON col.attrelid = i.indrelid AND col.attnum = i.indkey[0]
            WHERE i.indrelid = format('%I.%I', field.ns, field.tbl)::regclass
              AND i.indisvalid AND i.indisready AND col.attname = field.col
              AND pg_get_indexdef(i.indexrelid) = format(
                  'CREATE UNIQUE INDEX %I ON %I.%I USING btree (%I) WHERE (NOT deleted)',
                  idx.relname, field.ns, field.tbl, field.col)
              AND EXISTS (
                  SELECT FROM vks_application_version history
                  WHERE history.application_id = field.app
                    AND history.ddl @> jsonb_build_array(format(
                        'CREATE UNIQUE INDEX "%s" ON "%s"."%s" ("%s") WHERE NOT deleted',
                        idx.relname, field.ns, field.tbl, field.col)))
        LOOP
            IF field.is_unique AND NOT kept THEN
                IF old_name <> new_name THEN
                    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', field.ns, old_name, new_name);
                END IF;
                kept := true;
            ELSE
                EXECUTE format('DROP INDEX %I.%I', field.ns, old_name);
            END IF;
        END LOOP;
        -- A historical name collision could have removed a different catalog's index.
        -- Existing duplicates must abort the migration transaction with the data intact.
        IF field.is_unique AND NOT kept THEN
            EXECUTE format('CREATE UNIQUE INDEX %I ON %I.%I (%I) WHERE NOT deleted',
                           new_name, field.ns, field.tbl, field.col);
        END IF;
    END LOOP;
END
$migration$;
