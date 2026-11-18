import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("investigate a month-end control difference after both documents have been paid", async ({ page }) => {
  const post = async (path: string, data: object) => {
    const response = await page.request.post(`/api/v1${path}`, { data });
    await expect(response).toBeOK();
    return response.json();
  };
  await post("/auth/signup", {
    organizationName: "Period Close Fixture", name: "Pat Close",
    email: `close-${randomUUID()}@example.test`, password: "Close-fixture-2026",
  });
  const customer = await post("/customers", { displayName: "=Cedar Workshop" });
  const vendor = await post("/vendors", { displayName: "Bay Supply" });
  const service = await post("/items", { sku: "LABOR", name: "Installation", type: "service", salesPrice: "145.17" });
  const response = await page.request.get("/api/v1/accounts");
  await expect(response).toBeOK();
  const { data: accounts } = await response.json() as { data: { id: string; number: string }[] };
  const accountId = (number: string) => accounts.find((account) => account.number === number)!.id;

  const invoice = await post("/invoices", {
    customerId: customer.id, issueDate: "2024-03-15", dueDate: "2024-03-25",
    lines: [{ itemId: service.id, quantity: "1" }],
  });
  const bill = await post("/bills", {
    vendorId: vendor.id, vendorReference: "BS-417", billDate: "2024-03-15", dueDate: "2024-03-25",
    expenseLines: [{ accountId: accountId("6300"), amount: "80.12" }],
  });
  await post("/payments", {
    customerId: customer.id, date: "2024-04-02", amount: "145.17", method: "ach",
    applications: [{ invoiceId: invoice.id, amount: "145.17" }],
  });
  await post("/bill-payments", {
    vendorId: vendor.id, date: "2024-04-02", method: "ach", applications: [{ billId: bill.id, amount: "80.12" }],
  });
  await post("/payments", {
    customerId: customer.id, date: "2024-04-03", amount: "20.00", method: "ach", applications: [],
  });
  // The source supports 16 integer digits. Check cents all the way to the rendered ledger.
  const entry = await post("/journal-entries", {
    date: "2024-03-30", memo: "Manual AR adjustment",
    lines: [{ accountId: accountId("1200"), debit: "900719925474099.91" }, { accountId: accountId("3000"), credit: "900719925474099.91" }],
  });
  await post(`/journal-entries/${entry.id}/reverse`, { date: "2024-04-01" });

  await page.goto("/reports");
  await page.getByRole("link", { name: /Control Account Reconciliation/ }).click();
  const asOf = page.getByLabel("As of");
  await asOf.fill("2024-03-31");
  const ar = page.getByRole("row", { name: /1200 Accounts Receivable/ });
  const ap = page.getByRole("row", { name: /2000 Accounts Payable/ });
  await expect(ar).toContainText("Review");
  await expect(ar.getByRole("cell", { name: "$900,719,925,474,099.91", exact: true })).toBeVisible();
  await expect(ap).toContainText("Matches");
  const csvReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const csv = await csvReady;
  expect(csv.suggestedFilename()).toBe("control-reconciliation-2024-03-31.csv");
  expect(await readFile((await csv.path())!, "utf8")).toContain('"145.17","900719925474099.91"');
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  await ar.getByRole("link", { name: "1200 Accounts Receivable" }).click();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("2024-03-31");
  await expect(page.getByRole("row", { name: /Closing balance/ })).toContainText("$900,719,925,474,245.08");
  await page.getByRole("link", { name: `#${entry.number}`, exact: true }).click();
  await expect(page.getByRole("row", { name: /^Total/ }).getByText("$900,719,925,474,099.91", { exact: true })).toHaveCount(2);
  await page.goBack();
  await page.goBack();

  for (const [row, name, party, amount, empty] of [
    [ar, "Accounts Receivable aging balance", "Cedar Workshop", "$145.17", "No open customer balances on this date."],
    [ap, "Accounts Payable aging balance", "Bay Supply", "$80.12", "No open vendor balances on this date."],
  ] as const) {
    await row.getByRole("link", { name: new RegExp(name) }).click();
    await expect(asOf).toHaveValue("2024-03-31");
    await expect(page.getByRole("row", { name: new RegExp(party) })).toContainText(amount);
    await asOf.fill("2024-04-02");
    await expect(page.getByText(empty)).toBeVisible();
    if (row === ar) {
      await asOf.fill("2024-04-03");
      await expect(page.getByRole("row", { name: /Cedar Workshop/ })).toContainText("-$20.00");
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "CSV" }).click();
      const credits = await download;
      expect(credits.suggestedFilename()).toBe("ar-aging-2024-04-03.csv");
      const text = await readFile((await credits.path())!, "utf8");
      expect(text).toContain('"Credits (deduct)","Total"');
      expect(text).toContain(`"'=Cedar Workshop","0.00","0.00","0.00","0.00","0.00","20.00","-20.00"`);
    }
    await asOf.fill("");
    await expect(page.getByText("Choose a report date.")).toBeVisible();
    await expect(page.getByRole("button", { name: "CSV" })).toHaveCount(0);
    await page.goBack();
  }
  await asOf.fill("2024-04-02");
  await expect(page.getByRole("cell", { name: "Matches", exact: true })).toHaveCount(2);
  await page.reload();
  await expect(asOf).toHaveValue("2024-04-02");
  await expect(ar.getByText("$0.00", { exact: true })).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await asOf.fill("2024-03-31");
  await expect(ar).toContainText("Review");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
});
