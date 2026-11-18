import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountBalance, dbError, setupApp, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let organizationId: string;
let acct: (n: string) => string;

beforeAll(async () => {
  ctx = await setupApp();
  const s = await signUp(ctx.app);
  owner = s.client;
  organizationId = s.organizationId;
  const accounts = (await owner.ok("GET", "/accounts")).data as { id: string; number: string }[];
  acct = (n) => accounts.find((a) => a.number === n)!.id;
});
afterAll(() => ctx.close());

describe("General Ledger posting rules", () => {
  it("posts a balanced manual entry and numbers it sequentially", async () => {
    const a = await owner.ok("POST", "/journal-entries", {
      date: "2026-02-01",
      memo: "Owner funding",
      lines: [
        { accountId: acct("1010"), debit: "1000.00" },
        { accountId: acct("3000"), credit: "1000.00" },
      ],
    });
    const b = await owner.ok("POST", "/journal-entries", {
      date: "2026-02-02",
      lines: [
        { accountId: acct("6300"), debit: 12.5 },
        { accountId: acct("1010"), credit: "12.50" },
      ],
    });
    expect(b.number).toBe(a.number + 1);
    expect(await accountBalance(owner, acct("1010"))).toBe("987.50");
  });

  it("rejects an unbalanced entry with a clear message", async () => {
    const res = await owner.req("POST", "/journal-entries", {
      date: "2026-02-03",
      lines: [
        { accountId: acct("6300"), debit: "10.00" },
        { accountId: acct("1010"), credit: "9.99" },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("unbalanced_entry");
  });

  it("rejects lines with both a debit and a credit, and amounts with more than 2 decimals", async () => {
    const both = await owner.req("POST", "/journal-entries", {
      date: "2026-02-03",
      lines: [
        { accountId: acct("6300"), debit: "10.00", credit: "10.00" },
        { accountId: acct("1010"), credit: "0" },
      ],
    });
    expect(both.status).toBe(422);
    const precise = await owner.req("POST", "/journal-entries", {
      date: "2026-02-03",
      lines: [
        { accountId: acct("6300"), debit: "10.001" },
        { accountId: acct("1010"), credit: "10.001" },
      ],
    });
    expect(precise.status).toBe(400);
  });

  it("the database itself refuses an unbalanced entry, even bypassing the API", async () => {
    expect(
      await dbError(ctx.db.transaction(async (tx) => {
        const entry = await tx.execute<{ id: string }>(
          sql`insert into journal_entries (organization_id, number, date, source_type) values (${organizationId}, 999999, '2026-02-04', 'manual') returning id`,
        );
        const id = entry.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (organization_id, journal_entry_id, line_no, account_id, debit) values (${organizationId}, ${id}, 1, ${acct("6300")}, 5)`);
        await tx.execute(sql`insert into journal_lines (organization_id, journal_entry_id, line_no, account_id, credit) values (${organizationId}, ${id}, 2, ${acct("1010")}, 4)`);
      })),
    ).toMatch(/not balanced/);
  });

  it("posted lines cannot be edited or deleted", async () => {
    expect(await dbError(ctx.db.execute(sql`update journal_lines set debit = debit + 1 where organization_id = ${organizationId}`))).toMatch(/immutable/);
    expect(await dbError(ctx.db.execute(sql`delete from journal_lines where organization_id = ${organizationId}`))).toMatch(/immutable/);
    expect(await dbError(ctx.db.execute(sql`delete from journal_entries where organization_id = ${organizationId}`))).toMatch(/immutable/);
    expect(await dbError(ctx.db.execute(sql`update journal_entries set memo = 'changed' where organization_id = ${organizationId}`))).toMatch(/immutable/);
  });

  it("allows split line inserts while posting and seals the set of lines at commit, including reversals", async () => {
    const entryId = await ctx.db.transaction(async (tx) => {
      const header = await tx.execute<{ id: string }>(sql`
        insert into journal_entries (organization_id, number, date, source_type)
        values (${organizationId}, 900001, '2026-03-04', 'manual') returning id
      `);
      const id = header.rows[0]!.id;
      await tx.execute(sql`insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,debit)
        values (${organizationId},${id},1,${acct("1010")},2.50)`);
      await tx.execute(sql`insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,credit)
        values (${organizationId},${id},2,${acct("3000")},2.50)`);
      return id;
    });
    const reversal = await owner.ok("POST", `/journal-entries/${entryId}/reverse`, { date: "2026-03-05" });
    for (const id of [entryId, reversal.id]) {
      const prior = await owner.ok("GET", `/journal-entries/${id}`);
      expect(prior.lines).toHaveLength(2);
      const message = await dbError(ctx.db.execute(sql`insert into journal_lines
        (organization_id,journal_entry_id,line_no,account_id,debit,credit) values
        (${organizationId},${id},3,${acct("1010")},1,0), (${organizationId},${id},4,${acct("3000")},0,1)`));
      expect(message).toMatch(/sealed/);
      expect((await owner.ok("GET", `/journal-entries/${id}`)).lines).toEqual(prior.lines);
    }
  });

  it("keeps an uncommitted journal private to its writer and rolls its seal back with the header", async () => {
    const writer = await ctx.pool.connect();
    const other = await ctx.pool.connect();
    try {
      await writer.query("begin");
      const header = await writer.query<{ id: string }>(`
        insert into journal_entries (organization_id, number, date, source_type)
        values ($1, 900002, '2026-03-05', 'manual') returning id
      `, [organizationId]);
      const id = header.rows[0]!.id;
      await other.query("begin");
      await other.query("set local lock_timeout = '2s'");
      await expect(other.query(`insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,debit)
        values ($1,$2,1,$3,1)`, [organizationId, id, acct("1010")])).rejects.toMatchObject({ code: "23503" });
      await writer.query(`insert into journal_lines (organization_id,journal_entry_id,line_no,account_id,debit,credit)
        values ($1,$2,1,$3,1,0), ($1,$2,2,$4,0,1)`, [organizationId, id, acct("1010"), acct("3000")]);
      await writer.query("set constraints all immediate");
      expect((await writer.query("select 1 from journal_entry_seals where journal_entry_id=$1", [id])).rowCount).toBe(1);
      await writer.query("rollback");
      expect((await ctx.pool.query("select 1 from journal_entry_seals where journal_entry_id=$1", [id])).rowCount).toBe(0);
      expect((await owner.req("GET", `/journal-entries/${id}`)).status).toBe(404);
    } finally {
      await writer.query("rollback");
      await other.query("rollback");
      writer.release();
      other.release();
    }
  });

  it("reverses an entry once, linking both directions", async () => {
    const entry = await owner.ok("POST", "/journal-entries", {
      date: "2026-03-01",
      memo: "Mistake",
      lines: [
        { accountId: acct("6800"), debit: "300.00" },
        { accountId: acct("1010"), credit: "300.00" },
      ],
    });
    const before = await accountBalance(owner, acct("6800"));
    const reversal = await owner.ok("POST", `/journal-entries/${entry.id}/reverse`, { date: "2026-03-02" });
    expect(reversal.reversalOfId).toBe(entry.id);
    const original = await owner.ok("GET", `/journal-entries/${entry.id}`);
    expect(original.reversedById).toBe(reversal.id);
    expect(Number(await accountBalance(owner, acct("6800")))).toBe(Number(before) - 300);

    const again = await owner.req("POST", `/journal-entries/${entry.id}/reverse`, { date: "2026-03-02" });
    expect(again.status).toBe(409);
    const ofReversal = await owner.req("POST", `/journal-entries/${reversal.id}/reverse`, { date: "2026-03-03" });
    expect(ofReversal.status).toBe(409);
  });

  it("does not post to archived accounts", async () => {
    const created = await owner.ok("POST", "/accounts", { number: "6950", name: "Temporary", type: "expense", subtype: "operating_expense" });
    await owner.ok("PATCH", `/accounts/${created.id}`, { isActive: false });
    const res = await owner.req("POST", "/journal-entries", {
      date: "2026-03-05",
      lines: [
        { accountId: created.id, debit: "1.00" },
        { accountId: acct("1010"), credit: "1.00" },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/archived/);
  });

  it("protects system accounts and account types with postings", async () => {
    const archive = await owner.req("PATCH", `/accounts/${acct("1200")}`, { isActive: false });
    expect(archive.status).toBe(422);
    const retype = await owner.req("PATCH", `/accounts/${acct("6300")}`, { type: "asset", subtype: "other_current_asset" });
    expect(retype.status).toBe(422);
  });

  it("closing the books blocks postings on or before the closed date, in the API and the database", async () => {
    await owner.ok("PATCH", "/org", { booksClosedThrough: "2026-03-31" });
    const res = await owner.req("POST", "/journal-entries", {
      date: "2026-03-31",
      lines: [
        { accountId: acct("6300"), debit: "1.00" },
        { accountId: acct("1010"), credit: "1.00" },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("period_closed");
    expect(
      await dbError(
        ctx.db.execute(sql`insert into journal_entries (organization_id, number, date, source_type) values (${organizationId}, 888888, '2026-01-15', 'manual')`),
      ),
    ).toMatch(/books are closed/);

    const after = await owner.req("POST", "/journal-entries", {
      date: "2026-04-01",
      lines: [
        { accountId: acct("6300"), debit: "1.00" },
        { accountId: acct("1010"), credit: "1.00" },
      ],
    });
    expect(after.status).toBe(201);
    await owner.ok("PATCH", "/org", { booksClosedThrough: null });
  });

  it("lists entries with their correct totals", async () => {
    const entry = await owner.ok("POST", "/journal-entries", {
      date: "2026-04-02",
      memo: "List total check",
      lines: [
        { accountId: acct("6400"), debit: "123.45" },
        { accountId: acct("1010"), credit: "123.45" },
      ],
    });
    const list = await owner.ok("GET", "/journal-entries?q=List%20total%20check");
    expect(list.data.find((e: { id: string }) => e.id === entry.id).total).toBe("123.45");
  });

  it("keeps the trial balance balanced", async () => {
    const tb = await owner.ok("GET", "/reports/trial-balance?asOf=2026-12-31");
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("records an audit trail that cannot be altered", async () => {
    const events = await owner.ok("GET", "/audit-events?limit=200");
    const actions = events.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["journal.posted", "journal.reversed", "books.closed", "books.reopened"]));
    expect(await dbError(ctx.db.execute(sql`delete from audit_events where organization_id = ${organizationId}`))).toMatch(/immutable/);
  });
});
