import type { PoolClient } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupApp, setupCompany, signUp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => ctx.close());

// Release the first transaction only after PostgreSQL itself reports a waiter.
// If the second operation finished without blocking, return its actual outcome.
async function releaseAfterWait<T>(blocker: PoolClient, request: Promise<T>) {
  let finished = false;
  const pending = request.finally(() => { finished = true; });
  let blocked = false;
  try {
    const deadline = Date.now() + 6000;
    while (!finished && Date.now() < deadline) {
      const result = await blocker.query<{ waiting: boolean }>(`
        select exists(select 1 from pg_locks where not granted and pg_backend_pid() = any(pg_blocking_pids(pid))) as waiting
      `);
      if (result.rows[0]!.waiting) {
        blocked = true;
        break;
      }
      await delay(10);
    }
  } finally {
    await blocker.query("commit");
  }
  return { blocked, response: await pending };
}

it.each(["journal", "free stock"])("a %s posting respects a concurrent close on its posting date", async (kind) => {
  const { client, organizationId } = await signUp(ctx.app);
  const co = await setupCompany(client);
  const close = await ctx.pool.connect();
  try {
    await close.query("begin");
    await close.query("update organizations set books_closed_through = '2026-01-31' where id = $1", [organizationId]);
    const post = kind === "journal"
      ? client.req("POST", "/journal-entries", {
        date: "2026-01-31", lines: [{ accountId: co.acct("1010"), debit: "1.00" }, { accountId: co.acct("3000"), credit: "1.00" }],
      })
      : client.req("POST", "/inventory/adjustments", {
        date: "2026-01-31", reason: "received", lines: [{ itemId: co.widget.id, quantityChange: "1", unitCost: "0.00" }],
      });
    const { response, blocked } = await releaseAfterWait(close, post);
    expect(blocked).toBe(true);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("period_closed");
    expect((await client.ok("GET", "/journal-entries")).total).toBe(1);
    expect((await client.ok("GET", "/inventory/adjustments"))).toHaveLength(1);
    expect((await client.ok("GET", "/inventory/movements"))).toHaveLength(1);
    expect((await client.ok("GET", `/items/${co.widget.id}`)).qtyOnHand).toBe("10.0000");
  } finally {
    await close.query("rollback");
    close.release();
  }
});

it("a close waits for an already posted, uncommitted journal before taking effect", async () => {
  const { client, organizationId } = await signUp(ctx.app);
  const co = await setupCompany(client);
  const posting = await ctx.pool.connect();
  try {
    await posting.query("begin");
    const posted = await posting.query<{ id: string }>(
      "insert into journal_entries (organization_id, number, date, source_type) values ($1, 99999, '2026-03-31', 'manual') returning id", [organizationId],
    );
    await posting.query(`
      insert into journal_lines (organization_id, journal_entry_id, line_no, account_id, debit, credit)
      values ($1,$2,1,$3,1,0), ($1,$2,2,$4,0,1)
    `, [organizationId, posted.rows[0]!.id, co.acct("1010"), co.acct("3000")]);
    const { response, blocked } = await releaseAfterWait(posting, client.req("PATCH", "/org", { booksClosedThrough: "2026-03-31" }));
    expect(blocked).toBe(true);
    expect(response.status).toBe(200);
    expect((await client.ok("GET", `/journal-entries/${posted.rows[0]!.id}`)).lines).toHaveLength(2);
  } finally {
    await posting.query("rollback");
    posting.release();
  }
});

it("audits a partial reopen against the latest concurrent close and permits free stock in the reopened range", async () => {
  const { client, organizationId } = await signUp(ctx.app);
  const co = await setupCompany(client);
  await client.ok("PATCH", "/org", {
    booksClosedThrough: "2026-01-31", legalName: "Workshop Inc.", phone: "555-0100", email: "billing@example.test",
  });
  const close = await ctx.pool.connect();
  try {
    await close.query("begin");
    await close.query("update organizations set books_closed_through = '2026-04-30' where id = $1", [organizationId]);
    const { response, blocked } = await releaseAfterWait(close, client.req("PATCH", "/org", { booksClosedThrough: "2026-02-28" }));
    expect(blocked).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ legalName: "Workshop Inc.", phone: "555-0100", email: "billing@example.test" });
    const audit = await client.ok("GET", "/audit-events?limit=50");
    expect(audit.data).toContainEqual(expect.objectContaining({
      action: "books.reopened", data: { from: "2026-04-30", to: "2026-02-28" },
    }));
    const stock = (date: string) => client.req("POST", "/inventory/adjustments", {
      date, reason: "received", lines: [{ itemId: co.widget.id, quantityChange: "1", unitCost: "0.00" }],
    });
    expect((await stock("2026-02-28")).body.error.code).toBe("period_closed");
    const reopened = await stock("2026-03-01");
    expect(reopened.status).toBe(201);
    expect(reopened.body.journalEntryId).toBe(null);
  } finally {
    await close.query("rollback");
    close.release();
  }
});
