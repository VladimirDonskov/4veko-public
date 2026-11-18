/**
 * Latency benchmark for key API operations, in-process (Fastify inject:
 * full routing, validation, auth and Postgres, no network hop).
 *
 *   npm run bench -w @4veko/api            uses TEST_DATABASE_URL (wiped!)
 *
 * Seeds the demo company, measures reads, then posts 1,000 more invoices and
 * payments and measures again at that size. Prints a markdown table.
 */
import { performance } from "node:perf_hooks";
import os from "node:os";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { DEMO_OWNER, DEMO_PASSWORD, seed } from "../src/db/seed";
import { buildApp } from "../src/server";

const url = process.env.TEST_DATABASE_URL ?? "postgres://veko:veko_dev_password@localhost:5433/veko_test";

type Stat = { name: string; n: number; p50: number; p95: number; max: number };

function stats(name: string, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { name, n: s.length, p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1]! };
}

async function main() {
  await seed(url, { reset: true, quiet: true });
  const { db, pool } = createDb(url);
  const app = await buildApp({ config: loadConfig({ ...process.env, DATABASE_URL: url, LOG_LEVEL: "silent" }), db, logger: false });
  let cookie = "";
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${path}`, payload: body as object, headers: cookie ? { cookie } : {} });
    const sc = res.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;
    if (res.statusCode >= 400) throw new Error(`${method} ${path} ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const time = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };

  await call("POST", "/auth/login", { email: DEMO_OWNER, password: DEMO_PASSWORD });
  const customer = (await call("GET", "/customers?limit=1")).data[0];
  const service = (await call("GET", "/items?type=service")).data[0];
  const stocked = (await call("GET", "/items?type=inventory")).data[0];

  const reads: [string, string][] = [
    ["GET /dashboard", "/dashboard"],
    ["GET /invoices (100 rows)", "/invoices?limit=100"],
    ["GET /reports/trial-balance", "/reports/trial-balance"],
    ["GET /reports/balance-sheet", "/reports/balance-sheet"],
    ["GET /reports/profit-and-loss", "/reports/profit-and-loss"],
    ["GET /reports/ar-aging", "/reports/ar-aging"],
    ["GET /reports/ap-aging", "/reports/ap-aging"],
    ["GET /reports/control-reconciliation", "/reports/control-reconciliation"],
    ["GET /search?q=bl", "/search?q=bl"],
  ];
  const measureReads = async (label: string) => {
    const out: Stat[] = [];
    for (const [name, path] of reads) {
      for (let i = 0; i < 5; i++) await call("GET", path); // warm-up
      const samples: number[] = [];
      for (let i = 0; i < 50; i++) samples.push(await time(() => call("GET", path)));
      out.push(stats(`${name} — ${label}`, samples));
    }
    return out;
  };

  const results: Stat[] = [];
  results.push(...(await measureReads("seeded")));

  // Write path: 1,000 invoices (service + 1 stocked unit, restocked as needed) and full payments.
  await call("POST", "/inventory/adjustments", {
    date: "2026-01-03",
    reason: "received",
    lines: [{ itemId: stocked.id, quantityChange: "2000", unitCost: "10.00" }],
  });
  const invoiceTimes: number[] = [];
  const paymentTimes: number[] = [];
  for (let i = 0; i < 1000; i++) {
    let inv: { id: string; total: string } | undefined;
    invoiceTimes.push(
      await time(async () => {
        inv = await call("POST", "/invoices", {
          customerId: customer.id,
          issueDate: "2026-06-15",
          lines: [
            { itemId: service.id, quantity: "1" },
            { itemId: stocked.id, quantity: "1" },
          ],
        });
      }),
    );
    paymentTimes.push(
      await time(() =>
        call("POST", "/payments", { customerId: customer.id, date: "2026-06-20", amount: inv!.total, method: "ach", applications: [{ invoiceId: inv!.id, amount: inv!.total }] }),
      ),
    );
  }
  results.push(stats("POST /invoices (post invoice + stock + GL)", invoiceTimes));
  results.push(stats("POST /payments (apply + GL)", paymentTimes));
  const counts = await pool.query("select (select count(*) from invoices) inv, (select count(*) from journal_lines) jl");
  results.push(...(await measureReads(`after +1,000 invoices`)));

  const tb = await call("GET", "/reports/trial-balance");
  const version = await pool.query<{ server_version: string }>("show server_version");
  console.log(`\nMachine: ${os.cpus()[0]?.model} (${os.cpus().length} threads), ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, Node ${process.version}, PostgreSQL ${version.rows[0]!.server_version}`);
  console.log(`Data after run: ${counts.rows[0].inv} invoices, ${counts.rows[0].jl} journal lines. Trial balance balanced: ${tb.balanced}\n`);
  console.log("| operation | samples | p50 ms | p95 ms | max ms |\n| --- | ---: | ---: | ---: | ---: |");
  for (const r of results) console.log(`| ${r.name} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} |`);
  await app.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
