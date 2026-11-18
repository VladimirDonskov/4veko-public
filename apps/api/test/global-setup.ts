import { sql } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";

// Migrate the test database and empty it once per run. Test files create
// their own organizations, so they never depend on each other's data.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://veko:veko_dev_password@localhost:5433/veko_test";
  await runMigrations(url);
  const { db, pool } = createDb(url);
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%'`,
  );
  const names = tables.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  await pool.end();
}
