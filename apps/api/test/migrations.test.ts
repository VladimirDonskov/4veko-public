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

async function migrateThrough(lastIndex: number) {
  const legacy = await mkdtemp(path.join(tmpdir(), "veko-legacy-migrations-"));
  const { db, pool } = createDb(scratchUrl);
  try {
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIndex);
    await mkdir(path.join(legacy, "meta"));
    await writeFile(path.join(legacy, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      const file = entry.tag + ".sql";
      await copyFile(path.join(migrationsFolder, file), path.join(legacy, file));
    }
    await migrate(db, { migrationsFolder: legacy });
  } finally {
    await pool.end();
    await rm(legacy, { recursive: true, force: true });
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
      expect(tables.rows[0].n).toBe(38);
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

  it("preserves populated 0004 journals and scopes bank matches to their original organization and account", async () => {
    const { pool } = createDb(scratchUrl);
    try {
      await migrateThrough(4);
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

      const createStatement = (organizationId: string, accountId: string) => pool.query(
        `insert into bank_statements (organization_id, account_id, external_id, start_date, end_date, opening_balance, closing_balance)
         values ($1,$2,'jan','2024-01-01','2024-01-31',0,21.17) returning id`,
        [organizationId, accountId],
      );
      const statement = (await createStatement(org.id, accounts[0].id)).rows[0];
      const line = await pool.query(
        `insert into bank_statement_lines (organization_id, account_id, statement_id, external_id, date, description, amount, journal_line_id)
         values ($1,$2,$3,'deposit-1','2024-01-01','Opening deposit',21.17,$4) returning id`,
        [org.id, accounts[0].id, statement.id, before.rows[0].id],
      );
      await expect(pool.query("update bank_statement_lines set journal_line_id = $1 where id = $2", [
        before.rows[1].id, line.rows[0].id,
      ])).rejects.toMatchObject({ code: "23503", constraint: "bsl_journal_line_fk" });
      const other = (await pool.query("insert into organizations (name) values ('Other organization') returning id")).rows[0];
      await expect(createStatement(other.id, accounts[0].id)).rejects.toMatchObject({
        code: "23503", constraint: "bs_account_fk",
      });
      await expect(pool.query("update bank_statement_lines set organization_id = $1, journal_line_id = null where id = $2", [
        other.id, line.rows[0].id,
      ])).rejects.toMatchObject({ code: "23503", constraint: "bsl_statement_fk" });
    } finally {
      await pool.end();
    }
  });

  it("upgrades existing receipts from 0007 and enforces tenant-scoped deposit membership and exclusive active claims", async () => {
    await migrateThrough(7);
    const { pool } = createDb(scratchUrl);
    async function posting(org: string, number: number, date: string, source: string, debit: string, credit: string) {
      const result = await pool.query(`
        with journal as (
          insert into journal_entries (organization_id,number,date,source_type) values ($1,$2,$3,$4) returning id
        ) insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,debit,credit)
          select $1,id,1,$5::uuid,27.34,0 from journal union all select $1,id,2,$6::uuid,0,27.34 from journal
          returning journal_entry_id`, [org, number, date, source, debit, credit]);
      return result.rows[0].journal_entry_id as string;
    }
    async function legacyReceipt(company: string) {
      const org: string = (await pool.query("insert into organizations (name) values ($1) returning id", [company])).rows[0].id;
      const { rows: accounts } = await pool.query(`
        insert into accounts (organization_id,number,name,type,subtype,system_key) values
          ($1,'1010','Bank','asset','bank','cash_operating'), ($1,'1050','Undeposited Funds','asset','cash','undeposited_funds'),
          ($1,'1200','Accounts Receivable','asset','accounts_receivable','accounts_receivable') returning id,number`, [org]);
      const account = (number: string) => accounts.find(a => a.number === number)!.id as string;
      const customer = await pool.query("insert into parties (organization_id,kind,display_name) values ($1,'customer','Buyer') returning id", [org]);
      const entry = await posting(org, 1, "2026-01-01", "payment", account("1050"), account("1200"));
      const receipt = await pool.query(`
        insert into payments (organization_id,number,customer_id,date,amount,unapplied_amount,method,deposit_account_id,journal_entry_id)
        values ($1,'PMT-0001',$2,'2026-01-01',27.34,27.34,'check',$3,$4) returning id`, [org, customer.rows[0].id, account("1050"), entry]);
      return { org, bank: account("1010"), clearing: account("1050"), payment: receipt.rows[0].id as string };
    }
    try {
      const own = await legacyReceipt("Legacy receivables");
      const other = await legacyReceipt("Independent books");
      const receipts = await pool.query("select * from payments order by id");
      const journals = await pool.query("select * from journal_lines order by id");
      await runMigrations(scratchUrl);
      await runMigrations(scratchUrl);
      expect((await pool.query("select * from payments order by id")).rows).toEqual(receipts.rows);
      expect((await pool.query("select * from journal_lines order by id")).rows).toEqual(journals.rows);
      expect((await pool.query("select deposit_id from deposit_payments")).rows).toHaveLength(0);

      async function deposit(number: number, date: string) {
        const entry = await posting(own.org, number, date, "deposit", own.bank, own.clearing);
        const result = await pool.query(`
          insert into deposits (organization_id,number,date,bank_account_id,amount,journal_entry_id)
          values ($1,$2,$3,$4,27.34,$5) returning id`, [own.org, `DEP-${number}`, date, own.bank, entry]);
        return result.rows[0].id as string;
      }
      const first = await deposit(2, "2026-01-03");
      const replacement = await deposit(3, "2026-01-10");
      const claim = (depositId: string, receiptId: string) => pool.query(
        "insert into deposit_payments (organization_id,deposit_id,payment_id) values ($1,$2,$3)", [own.org, depositId, receiptId]);
      await claim(first, own.payment);
      await expect(claim(replacement, own.payment)).rejects.toMatchObject({ code: "23505", constraint: "dp_active_payment_uq" });
      await expect(claim(replacement, other.payment)).rejects.toMatchObject({ code: "23503", constraint: "dp_payment_fk" });
      await expect(pool.query("update deposits set bank_account_id=$1 where id=$2", [other.bank, first]))
        .rejects.toMatchObject({ code: "23503", constraint: "dep_bank_fk" });
      const reversal = await posting(own.org, 4, "2026-01-09", "deposit_void", own.clearing, own.bank);
      await pool.query(`
        with canceled as (
          update deposits set status='void', void_date='2026-01-09', void_reason='Correct batch', void_journal_entry_id=$2
          where id=$1 returning id,void_date
        ) update deposit_payments set released_on=canceled.void_date from canceled where deposit_id=canceled.id`, [first, reversal]);
      await claim(replacement, own.payment);
      expect((await pool.query("select deposit_id,released_on::text from deposit_payments where payment_id=$1 order by released_on nulls last", [own.payment])).rows)
        .toEqual([{ deposit_id: first, released_on: "2026-01-09" }, { deposit_id: replacement, released_on: null }]);
    } finally {
      await pool.end();
    }
  });
});
