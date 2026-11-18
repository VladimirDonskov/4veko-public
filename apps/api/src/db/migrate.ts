import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db (tsx) and dist/db (bundled build) both sit two levels below apps/api.
export const migrationsFolder = path.resolve(here, "../../drizzle");

export async function runMigrations(url: string) {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? "postgres://veko:veko_dev_password@localhost:5433/veko";
  runMigrations(url)
    .then(() => console.log("Migrations applied."))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
