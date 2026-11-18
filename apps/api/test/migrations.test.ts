import pg from "pg";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { migrationsFolder, runMigrations } from "../src/db/migrate";

// Applies every migration to a brand-new empty database, then checks the
// integrity objects the ledger relies on exist.
const base = new URL(process.env.TEST_DATABASE_URL!);
const scratchName = `veko_migrate_${randomUUID().replaceAll("-", "")}`;
const scratchUrl = (() => {
  const u = new URL(base);
  u.pathname = `/${scratchName}`;
  return u.toString();
})();
const adminUrl = (() => {
  const u = new URL(base);
  u.pathname = "/postgres";
  return u.toString();
})();

async function admin(sqlText: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sqlText);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await admin(`create database ${scratchName}`);
});
afterEach(async () => {
  await admin(`drop database if exists ${scratchName} with (force)`);
});

describe("database migrations", () => {
  it("apply cleanly to an empty database and are idempotent", async () => {
    await runMigrations(scratchUrl);
    await runMigrations(scratchUrl);
    const client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      const tables = await client.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
      expect(tables.rows[0].n).toBe(34);
      const triggers = await client.query("select tgname from pg_trigger where not tgisinternal order by tgname");
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        "audit_events_immutable",
        "journal_entries_guard_update",
        "journal_entries_have_lines",
        "journal_entries_no_delete",
        "journal_entries_period_open",
        "journal_entries_seal_lines",
        "journal_entry_seals_immutable",
        "journal_lines_balanced",
        "journal_lines_immutable",
        "journal_lines_require_unsealed_entry",
        "stock_moves_period_open",
      ]);
      const fks = await client.query(
        "select count(*)::int as n from pg_constraint where contype = 'f' and array_length(conkey, 1) = 2",
      );
      expect(fks.rows[0].n).toBeGreaterThan(30);
    } finally {
      await client.end();
    }
  });

  it("upgrades populated 0004 journals without changing their amounts or history", async () => {
    const legacy = await mkdtemp(path.join(tmpdir(), "veko-legacy-migrations-"));
    const { db, pool } = createDb(scratchUrl);
    try {
      // Use the original journal and migration files, including Drizzle's own tracking.
      const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 4);
      await mkdir(path.join(legacy, "meta"));
      await writeFile(path.join(legacy, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries) {
        const file = entry.tag + ".sql";
        await copyFile(path.join(migrationsFolder, file), path.join(legacy, file));
      }
      await migrate(db, { migrationsFolder: legacy });
      const { rows: [org] } = await pool.query("insert into organizations (name) values ('Legacy fixture') returning id");
      const { rows: accounts } = await pool.query(`insert into accounts (organization_id, number, name, type, subtype)
        values ($1,'1010','Bank','asset','bank'), ($1,'3000','Capital','equity','equity') returning id`, [org.id]);
      const client = await pool.connect();
      let entryId: string;
      try {
        await client.query("begin");
        const entry = await client.query("insert into journal_entries (organization_id,number,date,source_type) values ($1,1,'2024-01-01','manual') returning id", [org.id]);
        entryId = entry.rows[0].id;
        await client.query(`insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,debit,credit)
          values ($1,$2,1,$3,21.17,0), ($1,$2,2,$4,0,21.17)`, [org.id, entryId, accounts[0].id, accounts[1].id]);
        await client.query("commit");
      } finally {
        await client.query("rollback");
        client.release();
      }
      const before = await pool.query("select * from journal_lines order by line_no");
      const header = await pool.query("select * from journal_entries");
      await runMigrations(scratchUrl);
      await runMigrations(scratchUrl);
      expect((await pool.query("select * from journal_lines order by line_no")).rows).toEqual(before.rows);
      expect((await pool.query("select * from journal_entries")).rows).toEqual(header.rows);
      expect((await pool.query("select * from journal_entry_seals")).rows).toEqual([{ organization_id: org.id, journal_entry_id: entryId }]);
      await expect(pool.query("delete from journal_entry_seals where journal_entry_id = $1", [entryId])).rejects.toMatchObject({ code: "VK001" });
      await expect(pool.query("truncate journal_entry_seals")).rejects.toMatchObject({ code: "0A000" });
    } finally {
      await pool.end();
      await rm(legacy, { recursive: true, force: true });
    }
  });
});
