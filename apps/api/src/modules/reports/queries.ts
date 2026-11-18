import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { accounts, journalEntries, journalLines, organizations } from "../../db/schema";
import { daysBetween, fiscalYearStart } from "../../lib/dates";
import { AppError } from "../../lib/errors";
import { cents, dec, type Dec } from "../../lib/money";
import { normalBalance, type AccountType } from "../accounts/chart-template";

export type AccountTotal = {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  subtype: string;
  debit: string;
  credit: string;
  /** Balance in the account's normal direction. */
  balance: string;
};

/** Debit and credit totals per account for entries dated within [from, to]. */
export async function accountTotals(db: DbOrTx, organizationId: string, range: { from?: string; to?: string }, accountIds?: string[]) {
  const rows = await db
    .select({
      id: accounts.id,
      number: accounts.number,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0.00)::text`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0.00)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalLines.organizationId, organizationId),
        accountIds ? inArray(journalLines.accountId, accountIds) : undefined,
        range.from ? gte(journalEntries.date, range.from) : undefined,
        range.to ? lte(journalEntries.date, range.to) : undefined,
      ),
    )
    .groupBy(accounts.id)
    .orderBy(accounts.number);
  return rows.map<AccountTotal>((r) => {
    const net = dec(r.debit).minus(r.credit);
    return { ...r, balance: (normalBalance(r.type) === "debit" ? net : net.negated()).toFixed(2) };
  });
}

export async function trialBalance(db: DbOrTx, organizationId: string, asOf: string) {
  const rows = await accountTotals(db, organizationId, { to: asOf });
  const lines = rows
    .map((r) => {
      const net = dec(r.debit).minus(r.credit);
      return {
        accountId: r.id,
        number: r.number,
        name: r.name,
        type: r.type,
        debit: net.gt(0) ? net.toFixed(2) : "0.00",
        credit: net.lt(0) ? net.negated().toFixed(2) : "0.00",
      };
    })
    .filter((l) => l.debit !== "0.00" || l.credit !== "0.00");
  const totalDebit = lines.reduce((a, l) => a.plus(l.debit), dec(0));
  const totalCredit = lines.reduce((a, l) => a.plus(l.credit), dec(0));
  return { asOf, lines, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), balanced: totalDebit.equals(totalCredit) };
}

type Section = { title: string; accounts: { accountId: string; number: string; name: string; amount: string }[]; total: string };

function section(title: string, rows: AccountTotal[]): Section {
  const list = rows
    .filter((r) => !dec(r.balance).isZero())
    .map((r) => ({ accountId: r.id, number: r.number, name: r.name, amount: r.balance }));
  return { title, accounts: list, total: cents(list.reduce<Dec>((a, r) => a.plus(r.amount), dec(0))) };
}

export async function profitAndLoss(db: DbOrTx, organizationId: string, from: string, to: string) {
  const rows = await accountTotals(db, organizationId, { from, to });
  const income = section("Income", rows.filter((r) => r.type === "revenue" && r.subtype === "sales"));
  const cogs = section("Cost of Goods Sold", rows.filter((r) => r.type === "expense" && r.subtype === "cogs"));
  const expenses = section("Operating Expenses", rows.filter((r) => r.type === "expense" && r.subtype === "operating_expense"));
  const otherIncome = section("Other Income", rows.filter((r) => r.type === "revenue" && r.subtype !== "sales"));
  const otherExpenses = section("Other Expenses", rows.filter((r) => r.type === "expense" && r.subtype === "other_expense"));
  const grossProfit = dec(income.total).minus(cogs.total);
  const operatingIncome = grossProfit.minus(expenses.total);
  const netIncome = operatingIncome.plus(otherIncome.total).minus(otherExpenses.total);
  return {
    from,
    to,
    income,
    cogs,
    grossProfit: grossProfit.toFixed(2),
    expenses,
    operatingIncome: operatingIncome.toFixed(2),
    otherIncome,
    otherExpenses,
    netIncome: netIncome.toFixed(2),
  };
}

export async function netIncome(db: DbOrTx, organizationId: string, range: { from?: string; to?: string }) {
  const rows = await accountTotals(db, organizationId, range);
  return rows.reduce((acc, r) => {
    if (r.type === "revenue") return acc.plus(r.balance);
    if (r.type === "expense") return acc.minus(r.balance);
    return acc;
  }, dec(0));
}

export async function balanceSheet(db: DbOrTx, organizationId: string, asOf: string) {
  const [org] = await db
    .select({ fy: organizations.fiscalYearStartMonth })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const fyStart = fiscalYearStart(asOf, org?.fy ?? 1);
  const rows = await accountTotals(db, organizationId, { to: asOf });
  const assets = section("Assets", rows.filter((r) => r.type === "asset"));
  const liabilities = section("Liabilities", rows.filter((r) => r.type === "liability"));
  const equity = section("Equity", rows.filter((r) => r.type === "equity"));

  // No closing entries are posted: prior-year profit shows as retained
  // earnings and this fiscal year's profit as net income, both computed.
  const priorEarnings = await netIncome(db, organizationId, { to: dayBefore(fyStart) });
  const currentEarnings = await netIncome(db, organizationId, { from: fyStart, to: asOf });
  if (!priorEarnings.isZero()) {
    equity.accounts.push({ accountId: "", number: "", name: "Retained Earnings (prior years, computed)", amount: priorEarnings.toFixed(2) });
  }
  equity.accounts.push({ accountId: "", number: "", name: "Net Income (this fiscal year)", amount: currentEarnings.toFixed(2) });
  equity.total = cents(dec(equity.total).plus(priorEarnings).plus(currentEarnings));
  const liabilitiesAndEquity = dec(liabilities.total).plus(equity.total);
  return {
    asOf,
    fiscalYearStart: fyStart,
    assets,
    liabilities,
    equity,
    totalLiabilitiesAndEquity: liabilitiesAndEquity.toFixed(2),
    balanced: liabilitiesAndEquity.equals(assets.total),
  };
}

function dayBefore(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "over90"] as const;
type Bucket = (typeof AGING_BUCKETS)[number];

function bucketFor(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "over90";
}

// Net each document before aging it, so a fully settled document contributes
// no row. All movements for one report share a PostgreSQL statement snapshot.
async function openBalances(db: DbOrTx, organizationId: string, movements: SQL) {
  const result = await db.execute<{ partyId: string; name: string; dueDate: string; balance: string }>(sql`
    with movements(document_id, party_id, due_date, amount) as (${movements}),
    balances as (
      select party_id, due_date, sum(amount) as balance
      from movements
      group by party_id, document_id, due_date
      having sum(amount) <> 0
    )
    select p.id as "partyId", p.display_name as name, b.due_date as "dueDate", b.balance::text as balance
    from balances b join parties p on p.id = b.party_id and p.organization_id = ${organizationId}
  `);
  return result.rows;
}

/** Receivables aging using invoice, reversal and customer payment posting dates. */
export async function arAging(db: DbOrTx, organizationId: string, asOf: string) {
  const open = await openBalances(db, organizationId, sql`
    select i.id, i.customer_id, i.due_date, i.total
    from invoices i
    left join journal_entries rev on rev.organization_id = i.organization_id and rev.id = i.void_journal_entry_id
    where i.organization_id = ${organizationId} and i.issue_date <= ${asOf}
      and (rev.date is null or rev.date > ${asOf})
    union all
    select i.id, i.customer_id, i.due_date, -a.amount
    from payments p
    join payment_applications a on a.organization_id = p.organization_id and a.payment_id = p.id
    join invoices i on i.organization_id = a.organization_id and i.id = a.invoice_id
    where p.organization_id = ${organizationId} and p.date <= ${asOf}
    union all
    select null::uuid, p.customer_id, p.date, -p.unapplied_amount
    from payments p
    where p.organization_id = ${organizationId} and p.date <= ${asOf} and p.unapplied_amount > 0
  `);

  type Row = { customerId: string; customerName: string; buckets: Record<Bucket, Dec>; credits: Dec };
  const byCustomer = new Map<string, Row>();
  const row = (id: string, name: string) => {
    let r = byCustomer.get(id);
    if (!r) {
      r = {
        customerId: id,
        customerName: name,
        buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, dec(0)])) as Record<Bucket, Dec>,
        credits: dec(0),
      };
      byCustomer.set(id, r);
    }
    return r;
  };
  for (const document of open) {
    const r = row(document.partyId, document.name);
    const balance = dec(document.balance);
    if (balance.isNegative()) {
      // Includes amounts assigned to invoices whose issue date is after the cutoff.
      r.credits = r.credits.minus(balance);
    } else {
      const bucket = bucketFor(daysBetween(document.dueDate, asOf));
      r.buckets[bucket] = r.buckets[bucket].plus(balance);
    }
  }

  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, dec(0)])) as Record<Bucket, Dec>;
  let totalCredits = dec(0);
  const customers = [...byCustomer.values()]
    .map((r) => {
      for (const b of AGING_BUCKETS) totals[b] = totals[b].plus(r.buckets[b]);
      totalCredits = totalCredits.plus(r.credits);
      const gross = AGING_BUCKETS.reduce((a, b) => a.plus(r.buckets[b]), dec(0));
      return {
        customerId: r.customerId,
        customerName: r.customerName,
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, r.buckets[b].toFixed(2)])),
        unappliedCredits: r.credits.toFixed(2),
        total: gross.minus(r.credits).toFixed(2),
      };
    })
    .sort((a, b) => dec(b.total).comparedTo(a.total));
  const grand = AGING_BUCKETS.reduce((a, b) => a.plus(totals[b]), dec(0)).minus(totalCredits);
  return {
    asOf,
    buckets: AGING_BUCKETS,
    customers,
    totals: {
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, totals[b].toFixed(2)])),
      unappliedCredits: totalCredits.toFixed(2),
      total: grand.toFixed(2),
    },
  };
}

/** Payables aging using bill, reversal and vendor payment posting dates. */
export async function apAging(db: DbOrTx, organizationId: string, asOf: string) {
  const open = await openBalances(db, organizationId, sql`
    select b.id, b.vendor_id, b.due_date, b.total
    from bills b
    left join journal_entries rev on rev.organization_id = b.organization_id and rev.id = b.void_journal_entry_id
    where b.organization_id = ${organizationId} and b.bill_date <= ${asOf}
      and (rev.date is null or rev.date > ${asOf})
    union all
    select b.id, b.vendor_id, b.due_date, -a.amount
    from bill_payments p
    join bill_payment_applications a on a.organization_id = p.organization_id and a.bill_payment_id = p.id
    join bills b on b.organization_id = a.organization_id and b.id = a.bill_id
    where p.organization_id = ${organizationId} and p.date <= ${asOf}
  `);
  const empty = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, dec(0)])) as Record<Bucket, Dec>;
  const byVendor = new Map<string, { vendorId: string; vendorName: string; buckets: Record<Bucket, Dec> }>();
  const totals = empty();
  for (const b of open) {
    let r = byVendor.get(b.partyId);
    if (!r) byVendor.set(b.partyId, (r = { vendorId: b.partyId, vendorName: b.name, buckets: empty() }));
    const bucket = bucketFor(daysBetween(b.dueDate, asOf));
    r.buckets[bucket] = r.buckets[bucket].plus(b.balance);
    totals[bucket] = totals[bucket].plus(b.balance);
  }
  const vendors = [...byVendor.values()]
    .map((r) => ({
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, r.buckets[b].toFixed(2)])),
      total: AGING_BUCKETS.reduce((a, b) => a.plus(r.buckets[b]), dec(0)).toFixed(2),
    }))
    .sort((a, b) => dec(b.total).comparedTo(a.total));
  return {
    asOf,
    buckets: AGING_BUCKETS,
    vendors,
    totals: {
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, totals[b].toFixed(2)])),
      total: AGING_BUCKETS.reduce((a, b) => a.plus(totals[b]), dec(0)).toFixed(2),
    },
  };
}

/** Compare documents with independently posted GL balances at the same cutoff and database snapshot. */
export async function controlReconciliation(db: Db, organizationId: string, asOf: string) {
  const keys = ["accounts_receivable", "accounts_payable"] as const;
  return db.transaction(async (tx) => {
    const controls = await tx.select({
      key: accounts.systemKey, id: accounts.id, number: accounts.number, name: accounts.name,
    }).from(accounts).where(and(eq(accounts.organizationId, organizationId), inArray(accounts.systemKey, keys)));
    const ledger = await accountTotals(tx, organizationId, { to: asOf }, controls.map((account) => account.id));
    const ar = await arAging(tx, organizationId, asOf);
    const ap = await apAging(tx, organizationId, asOf);
    const rows = keys.map((key) => {
      const account = controls.find((a) => a.key === key);
      if (!account) throw new AppError(500, "missing_system_account", `System account "${key}" is missing.`);
      const ledgerBalance = ledger.find((a) => a.id === account.id)?.balance ?? "0.00";
      const subledgerBalance = key === "accounts_receivable" ? ar.totals.total : ap.totals.total;
      return {
        key, accountId: account.id, number: account.number, name: account.name, ledgerBalance, subledgerBalance,
        difference: cents(dec(ledgerBalance).minus(subledgerBalance)),
      };
    });
    return { asOf, rows };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
