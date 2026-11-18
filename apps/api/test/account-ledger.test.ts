import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupApp, signUp, type TestClient } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupApp>>;
let owner: TestClient;
let ar: string;
let ap: string;

beforeAll(async () => {
  ctx = await setupApp();
  const { client, organizationId } = await signUp(ctx.app);
  owner = client;
  const accounts: { id: string; systemKey: string | null }[] = (await owner.ok("GET", "/accounts")).data;
  ar = accounts.find((a) => a.systemKey === "accounts_receivable")!.id;
  ap = accounts.find((a) => a.systemKey === "accounts_payable")!.id;
  // One opening entry, 5,001 April postings, and a later posting outside the cutoff.
  // Each entry balances independently and goes through the normal database triggers.
  await ctx.db.execute(sql`
    with entries as (
      insert into journal_entries (organization_id, number, date, source_type)
      select ${organizationId}, n + 1,
        case when n = 0 then date '2025-03-31'
             when n <= 5000 then date '2025-04-01'
             when n = 5001 then date '2025-04-02' else date '2025-05-01' end, 'manual'
      from generate_series(0, 5002) n
      returning id, number
    ), amounts as (
      select id, case when number = 1 then 9999999999999999.91 else 0.01 end as amount from entries
    )
    insert into journal_lines (organization_id, journal_entry_id, line_no, account_id, debit, credit)
    select ${organizationId}::uuid, id, 1, ${ar}::uuid, amount, 0 from amounts
    union all select ${organizationId}::uuid, id, 2, ${ap}::uuid, 0, amount from amounts
  `);
});

afterAll(() => ctx.close());

it("shows the full dated closing balance when the detailed ledger exceeds 5,000 lines", async () => {
  for (const id of [ar, ap]) {
    const report = await owner.ok("GET", `/accounts/${id}?from=2025-04-01&to=2025-04-30`);
    expect(report.openingBalance).toBe("9999999999999999.91");
    expect(report.closingBalance).toBe("10000000000000049.92");
    expect(report.truncated).toBe(true);
    expect(report.lines).toHaveLength(5000);
    expect(report.lines[0].balance).toBe("9999999999999999.92");
    expect(report.lines.at(-1).balance).toBe("10000000000000049.91");
  }
  const chart = await owner.ok("GET", "/accounts?asOf=2025-04-30");
  for (const id of [ar, ap]) {
    expect(chart.data).toContainEqual(expect.objectContaining({ id, balance: "10000000000000049.92" }));
  }
});

it("distinguishes an exact-size page, an empty period with an opening balance, and a cutoff before the first posting", async () => {
  const full = await owner.ok("GET", `/accounts/${ar}?from=2025-04-01&to=2025-04-01`);
  expect(full.lines).toHaveLength(5000);
  expect(full.truncated).toBe(false);
  expect(full.closingBalance).toBe(full.lines.at(-1).balance);

  const empty = await owner.ok("GET", `/accounts/${ar}?from=2025-04-03&to=2025-04-30`);
  expect(empty).toMatchObject({ lines: [], truncated: false, openingBalance: "10000000000000049.92", closingBalance: "10000000000000049.92" });
  const earlier = await owner.ok("GET", "/accounts?asOf=2025-03-30");
  expect(earlier.data).toContainEqual(expect.objectContaining({ id: ar, balance: "0.00" }));
});
