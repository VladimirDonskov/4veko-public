/**
 * Demo data for a fictional US company, created through the real API routes
 * (app.inject), so every invoice, payment and stock move is posted exactly as
 * a user would post it.
 *
 *   npm run db:seed            seed if the demo user does not exist yet
 *   npm run db:seed -- --reset wipe ALL data in the target database first
 *
 * Demo sign-in (local development only):
 *   owner       demo@4veko.test       DemoPass2026!
 *   accountant  alex@4veko.test       DemoPass2026!
 *   sales       sam@4veko.test        DemoPass2026!
 *   viewer      viewer@4veko.test     DemoPass2026!
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { loadConfig } from "../config";
import { addDays, today } from "../lib/dates";
import { cents, dec } from "../lib/money";
import { buildApp } from "../server";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

export const DEMO_PASSWORD = "DemoPass2026!";
export const DEMO_OWNER = "demo@4veko.test";

type App = Awaited<ReturnType<typeof buildApp>>;

class Client {
  private cookie = "";
  constructor(private app: App) {}
  async call<T = any>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body as any,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) this.cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
    return res.json() as T;
  }
}

// Small deterministic generator so every seed run produces the same books.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function seed(url: string, opts: { reset?: boolean; quiet?: boolean } = {}) {
  const log = opts.quiet ? () => {} : (m: string) => console.log(m);
  await runMigrations(url);
  const { db, pool } = createDb(url);
  const config = loadConfig({ ...process.env, DATABASE_URL: url, LOG_LEVEL: "warn" });
  const app = await buildApp({ config, db, logger: false });
  try {
    if (opts.reset) {
      const tables = await db.execute<{ tablename: string }>(
        sql`select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%'`,
      );
      const names = tables.rows.map((r) => `"${r.tablename}"`).join(", ");
      if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
      log("Database wiped.");
    }
    const existing = await db.execute(sql`select 1 from users where lower(email) = ${DEMO_OWNER}`);
    if (existing.rows.length > 0) {
      log(`Demo data already present (${DEMO_OWNER}). Use --reset to recreate it.`);
      return;
    }

    const api = new Client(app);
    const now = today();
    const year = now.slice(0, 4);
    const rand = rng(20261028);

    await api.call("POST", "/auth/signup", {
      name: "Jordan Ellis",
      email: DEMO_OWNER,
      password: DEMO_PASSWORD,
      organizationName: "Harbor & Pine Supply Co.",
    });
    await api.call("PATCH", "/org", {
      legalName: "Harbor & Pine Supply Co., LLC",
      phone: "(503) 555-0142",
      email: "accounts@harborpine.example",
      address: { line1: "1200 NW Riverside Ave", city: "Portland", state: "OR", postalCode: "97209", country: "US" },
      defaultTaxRate: "7.00",
    });
    for (const m of [
      { email: "alex@4veko.test", name: "Alex Rivera", role: "accountant" },
      { email: "sam@4veko.test", name: "Sam Chen", role: "sales" },
      { email: "viewer@4veko.test", name: "Riley Brooks", role: "viewer" },
    ]) {
      await api.call("POST", "/org/members", { ...m, temporaryPassword: DEMO_PASSWORD });
    }
    log("Organization and team created.");

    const accounts = (await api.call<{ data: { id: string; number: string }[] }>("GET", "/accounts")).data;
    const acct = (n: string) => accounts.find((a) => a.number === n)!.id;

    const customers = [
      { displayName: "Bluebird Café Group", companyName: "Bluebird Café Group Inc.", email: "ap@bluebirdcafe.example", termsDays: 30 },
      { displayName: "Cedar Ridge Dental", email: "office@cedarridgedental.example", termsDays: 15 },
      { displayName: "Summit Trail Outfitters", email: "billing@summittrail.example", termsDays: 30 },
      { displayName: "Lakeside Property Management", email: "payables@lakesidepm.example", termsDays: 45 },
      { displayName: "Redwood Learning Center", email: "finance@redwoodlearning.example", termsDays: 30 },
      { displayName: "Copper Kettle Bakery", email: "hello@copperkettle.example", termsDays: 15 },
      { displayName: "Granite Peak Construction", email: "ap@granitepeak.example", termsDays: 30 },
      { displayName: "Maple Street Public Library", email: "accounts@maplestreetlibrary.example", termsDays: 30, taxExempt: true },
    ];
    const customerIds: string[] = [];
    for (const c of customers) {
      const row = await api.call<{ id: string }>("POST", "/customers", {
        ...c,
        phone: `(503) 555-0${100 + customerIds.length}`,
        billingAddress: { line1: `${200 + customerIds.length * 37} SE Main St`, city: "Portland", state: "OR", postalCode: "97214", country: "US" },
      });
      customerIds.push(row.id);
    }
    const vendorIds: Record<string, string> = {};
    for (const v of [
      { code: "PPW", displayName: "Pacific Paper Wholesale", email: "orders@pacificpaper.example", termsDays: 30 },
      { code: "EJD", displayName: "Evergreen Janitorial Distributors", email: "sales@evergreenjd.example", termsDays: 30 },
      { code: "BLS", displayName: "Brightline Lighting Supply", email: "ar@brightline.example", termsDays: 45 },
      { code: "NOF", displayName: "Northfield Office Furniture", email: "billing@northfieldfurniture.example", termsDays: 30 },
    ]) {
      const { code, ...body } = v;
      vendorIds[code] = (await api.call<{ id: string }>("POST", "/vendors", body)).id;
    }
    // Which vendor supplies each product line (by SKU prefix).
    const supplierOf = (sku: string) =>
      ({ PAP: "PPW", TWL: "PPW", GLV: "EJD", CLN: "EJD", BAG: "EJD", SOP: "EJD", LGT: "BLS", CHR: "NOF", DSK: "NOF", WBD: "NOF" })[sku.slice(0, 3)]!;
    log("Customers and vendors created.");

    const catalog = [
      { sku: "PAP-1001", name: "Recycled Copy Paper, Letter (case of 10 reams)", type: "inventory", unit: "case", salesPrice: "54.00", purchaseCost: "31.50", reorderPoint: "60", stock: 300 },
      { sku: "GLV-2010", name: "Nitrile Gloves, Medium (box of 100)", type: "inventory", unit: "box", salesPrice: "14.50", purchaseCost: "7.20", reorderPoint: "60", stock: 400 },
      { sku: "TWL-3012", name: "Paper Towel Rolls (12-pack)", type: "inventory", unit: "pack", salesPrice: "28.00", purchaseCost: "15.75", reorderPoint: "30", stock: 160 },
      { sku: "LGT-4040", name: "LED Shop Light, 4 ft", type: "inventory", unit: "ea", salesPrice: "39.99", purchaseCost: "21.00", reorderPoint: "15", stock: 70 },
      { sku: "CHR-5100", name: "Ergonomic Task Chair", type: "inventory", unit: "ea", salesPrice: "289.00", purchaseCost: "162.00", reorderPoint: "5", stock: 24 },
      { sku: "DSK-5200", name: "Standing Desk Frame, Dual Motor", type: "inventory", unit: "ea", salesPrice: "449.00", purchaseCost: "255.00", reorderPoint: "4", stock: 14 },
      { sku: "CLN-6001", name: "All-Purpose Cleaner Concentrate (1 gal)", type: "inventory", unit: "gal", salesPrice: "18.25", purchaseCost: "8.40", reorderPoint: "25", stock: 120 },
      { sku: "BAG-6033", name: "Trash Liners, 33 gal (case of 250)", type: "inventory", unit: "case", salesPrice: "46.00", purchaseCost: "24.80", reorderPoint: "20", stock: 90 },
      { sku: "SOP-6100", name: "Foaming Hand Soap Refill (1 gal)", type: "inventory", unit: "gal", salesPrice: "22.00", purchaseCost: "10.10", reorderPoint: "20", stock: 30 },
      { sku: "WBD-7046", name: "Magnetic Whiteboard, 4 x 6 ft", type: "inventory", unit: "ea", salesPrice: "219.00", purchaseCost: "118.00", reorderPoint: "3", stock: 9 },
      { sku: "SVC-DLV", name: "Delivery and Setup", type: "service", unit: "visit", salesPrice: "85.00", taxable: false },
      { sku: "SVC-CON", name: "Workspace Planning Consultation (hour)", type: "service", unit: "hr", salesPrice: "125.00", taxable: false },
      { sku: "SGN-9000", name: "Custom Printed Signage", type: "non_inventory", unit: "ea", salesPrice: "65.00", purchaseCost: "28.00" },
    ] as const;
    const itemIds: Record<string, string> = {};
    for (const c of catalog) {
      const { stock: _stock, ...item } = c as typeof c & { stock?: number };
      const row = await api.call<{ id: string }>("POST", "/items", item);
      itemIds[item.sku] = row.id;
    }
    log("Catalog created.");

    const openingDate = `${year}-01-02`;
    await api.call("POST", "/journal-entries", {
      date: openingDate,
      memo: "Owner capital contribution",
      lines: [
        { accountId: acct("1010"), debit: "60000.00", description: "Initial funding" },
        { accountId: acct("3000"), credit: "60000.00" },
      ],
    });
    const stocked = catalog.filter((c) => c.type === "inventory") as unknown as { sku: string; purchaseCost: string; stock: number }[];
    await api.call("POST", "/inventory/adjustments", {
      date: openingDate,
      reason: "opening_balance",
      memo: "Opening stock count",
      lines: stocked.map((c) => ({ itemId: itemIds[c.sku]!, quantityChange: String(c.stock), unitCost: c.purchaseCost })),
    });

    // Month start: pay the month's operating expenses and restock anything
    // below 60% of its target level (paid from checking on delivery).
    const startMonth = async (monthStartDate: string, m: number) => {
      const payroll = cents(dec(3000).plus(m * 40));
      const utilities = cents(dec(180).plus((m % 3) * 25));
      const totalExp = cents(dec(1650).plus(payroll).plus(240).plus(utilities));
      await api.call("POST", "/journal-entries", {
        date: monthStartDate,
        memo: `Monthly operating expenses, ${monthStartDate.slice(0, 7)}`,
        lines: [
          { accountId: acct("6500"), debit: "1650.00", description: "Warehouse rent" },
          { accountId: acct("6600"), debit: payroll, description: "Payroll" },
          { accountId: acct("6700"), debit: "240.00", description: "Software subscriptions" },
          { accountId: acct("6900"), debit: utilities, description: "Utilities" },
          { accountId: acct("1010"), credit: totalExp },
        ],
      });
      if (m === 1) return;
      // Restock through the full purchasing cycle: one purchase order per
      // supplier for anything below 60% of target, received on the 1st,
      // billed a few days later (sometimes at a slightly different price)
      // and paid when due.
      const levels = (await api.call<{ data: { itemId: string; sku: string; qtyOnHand: string }[] }>("GET", "/inventory")).data;
      const bySupplier = new Map<string, { itemId: string; quantity: string; unitCost: string }[]>();
      for (const c of stocked) {
        const onHand = Number(levels.find((l) => l.sku === c.sku)?.qtyOnHand ?? 0);
        if (onHand >= c.stock * 0.6) continue;
        const list = bySupplier.get(supplierOf(c.sku)) ?? [];
        list.push({ itemId: itemIds[c.sku]!, quantity: String(c.stock - onHand), unitCost: cents(dec(c.purchaseCost).times(1 + m * 0.005)) });
        bySupplier.set(supplierOf(c.sku), list);
      }
      for (const [code, lines] of bySupplier) {
        const vendorId = vendorIds[code]!;
        const po = await api.call<{ id: string }>("POST", "/purchase-orders", {
          vendorId,
          orderDate: addDays(monthStartDate, -4),
          expectedDate: monthStartDate,
          lines,
        });
        await api.call("POST", `/purchase-orders/${po.id}/issue`);
        await api.call("POST", `/purchase-orders/${po.id}/receive`, { date: monthStartDate });
        const billDate = addDays(monthStartDate, 3);
        if (billDate > now) continue;
        const billable = await api.call<{ purchaseOrderLineId: string; purchaseOrderId: string; billableQuantity: string; unitCost: string }[]>(
          "GET",
          `/bills/billable-lines?vendorId=${vendorId}`,
        );
        const variance = rand() < 0.25 ? 1.02 : 1;
        const bill = await api.call<{ id: string; total: string; dueDate: string }>("POST", "/bills", {
          vendorId,
          vendorReference: `${code}-${monthStartDate.slice(0, 7).replace("-", "")}`,
          billDate,
          poLines: billable
            .filter((b) => b.purchaseOrderId === po.id)
            .map((b) => ({ purchaseOrderLineId: b.purchaseOrderLineId, quantity: b.billableQuantity, unitCost: dec(b.unitCost).times(variance).toDecimalPlaces(2).toFixed(2) })),
        });
        if (bill.dueDate <= now) {
          await api.call(
            "POST",
            "/bill-payments",
            { vendorId, date: bill.dueDate, method: rand() < 0.7 ? "ach" : "check", reference: `PAY-${code}-${monthStartDate.slice(0, 7)}`, applications: [{ billId: bill.id, amount: bill.total }] },
            { "idempotency-key": `seed-billpay-${bill.id}` },
          );
        }
      }
    };

    // Sales from early January until today, every two to three days.
    const skus = stocked.map((c) => c.sku);
    let orders = 0;
    let invoiced = 0;
    let paid = 0;
    let month = 0;
    for (let day = `${year}-01-06`; day <= now; day = addDays(day, 2 + Math.floor(rand() * 2))) {
      const m = Number(day.slice(5, 7));
      while (month < m) {
        month++;
        await startMonth(`${year}-${String(month).padStart(2, "0")}-01`, month);
      }
      const customerId = customerIds[Math.floor(rand() * customerIds.length)]!;
      const lineCount = 1 + Math.floor(rand() * 4);
      const lines: { itemId: string; quantity: string; discountPct?: string }[] = [];
      const used = new Set<string>();
      for (let i = 0; i < lineCount; i++) {
        const sku = skus[Math.floor(rand() * skus.length)]!;
        if (used.has(sku)) continue;
        used.add(sku);
        const big = sku.startsWith("CHR") || sku.startsWith("DSK") || sku.startsWith("WBD");
        lines.push({ itemId: itemIds[sku]!, quantity: String(big ? 1 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 18)) });
      }
      if (rand() < 0.35) lines.push({ itemId: itemIds["SVC-DLV"]!, quantity: "1" });
      if (rand() < 0.1) lines.push({ itemId: itemIds["SVC-CON"]!, quantity: String(1 + Math.floor(rand() * 4)) });
      if (rand() < 0.12) lines.push({ itemId: itemIds["SGN-9000"]!, quantity: String(1 + Math.floor(rand() * 4)), discountPct: "10" });

      const order = await api.call<{ id: string }>("POST", "/sales-orders", { customerId, orderDate: day, lines });
      orders++;
      // Leave the newest orders open so the dashboard has a pipeline.
      if (day > addDays(now, -6)) {
        if (rand() < 0.5) await api.call("POST", `/sales-orders/${order.id}/confirm`);
        continue;
      }
      let invoice: { id: string; total: string; dueDate: string };
      try {
        invoice = await api.call("POST", `/sales-orders/${order.id}/invoice`, { issueDate: day });
      } catch (err) {
        if (String(err).includes("insufficient_stock")) continue;
        throw err;
      }
      invoiced++;
      // Most invoices are paid within terms; recent ones partly; a few go overdue.
      const roll = rand();
      const old = Date.parse(now) - Date.parse(day) > 75 * 86_400_000;
      const payDate = addDays(day, 8 + Math.floor(rand() * 28));
      if (payDate > now) continue;
      if (roll < (old ? 0.97 : 0.82)) {
        await api.call(
          "POST",
          "/payments",
          { customerId, date: payDate, amount: invoice.total, method: rand() < 0.6 ? "ach" : "check", reference: `REF-${1000 + paid}`, applications: [{ invoiceId: invoice.id, amount: invoice.total }] },
          { "idempotency-key": `seed-payment-${invoice.id}` },
        );
        paid++;
      } else if (roll < (old ? 0.99 : 0.9)) {
        const half = cents(dec(invoice.total).dividedBy(2));
        await api.call("POST", "/payments", { customerId, date: payDate, amount: half, method: "card", applications: [{ invoiceId: invoice.id, amount: half }] });
        paid++;
      }
    }

    // Month-end bank deposits of customer payments, except the current month.
    const undeposited = accounts.find((a) => a.number === "1050")!.id;
    for (let mm = 1; mm < Number(now.slice(5, 7)); mm++) {
      const monthEnd = addDays(`${year}-${String(mm + 1).padStart(2, "0")}-01`, -1);
      const balance = (await api.call<{ closingBalance: string }>("GET", `/accounts/${undeposited}?to=${monthEnd}`)).closingBalance;
      if (dec(balance).lte(0)) continue;
      await api.call("POST", "/journal-entries", {
        date: monthEnd,
        memo: `Bank deposit of customer payments, ${monthEnd.slice(0, 7)}`,
        lines: [
          { accountId: acct("1010"), debit: balance, description: "Deposit" },
          { accountId: undeposited, credit: balance },
        ],
      });
    }
    log(`Sales posted: ${orders} orders, ${invoiced} invoices, ${paid} payments.`);
    log(`Done. Sign in as ${DEMO_OWNER} / ${DEMO_PASSWORD}`);
  } finally {
    await app.close();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? "postgres://veko:veko_dev_password@localhost:5433/veko";
  seed(url, { reset: process.argv.includes("--reset") }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
