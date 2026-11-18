# ERP restore drill

On November 18, 2026 a quiescent PostgreSQL 18.6 benchmark database was dumped and restored into a separately created, empty database on loopback. The custom-format archive was 1,160,179 bytes. The restore took 1.07 seconds on this machine. The fixture included 1,110 invoices, 2,319 journal entries, 9,067 journal lines and 1,299 stock movements. The source contained five Drizzle migrations through `0004_configurations`.

The [verification SQL](../../apps/api/scripts/restore-fingerprint.sql) compared the contents and counts of all 34 tables in the application and migration schemas, plus the values of three PostgreSQL sequences. All 37 fingerprints matched. Every restored journal had at least two lines and equal debit and credit totals. MD5 fingerprints detect accidental differences in this trusted synthetic fixture.

A second drill used the same sized benchmark on the final 0006 schema. All 38 fingerprints matched between the source and the new restore, including the 2,319 journal seals. Both databases passed the balance assertion. Separately, upgrading a populated 0004 database to 0006 and rerunning the migrator preserved its journal headers and lines.

## Reproduce on a disposable cluster

Use a populated, quiescent ERP fixture and a fresh database name. Set the standard PostgreSQL connection variables (`PGHOST`, `PGPORT`, `PGUSER` and the local authentication configuration) for that cluster. Use PostgreSQL client utilities compatible with the server version.

```sh
pg_dump -Fc --no-owner --no-acl --file=erp.dump veko_fixture
createdb veko_restore
pg_restore --exit-on-error --single-transaction --no-owner --no-acl -d veko_restore erp.dump
psql -X -qAt -v ON_ERROR_STOP=1 -d veko_fixture -f apps/api/scripts/restore-fingerprint.sql > original.signature
psql -X -qAt -v ON_ERROR_STOP=1 -d veko_restore -f apps/api/scripts/restore-fingerprint.sql > restored.signature
diff -u original.signature restored.signature
```

The [CI workflow](../../.github/workflows/ci.yml) repeats the drill after the browser journeys with the test service's matching client binaries. The local exercise verifies logical ERP data recovery for one fixture. Production recovery still requires encrypted backup storage, retention and access controls, tested role and secret provisioning, scheduled recovery tests for the separate VekoScript database, and agreed recovery-time and recovery-point targets.
