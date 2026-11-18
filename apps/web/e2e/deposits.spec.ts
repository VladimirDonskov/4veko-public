import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("group customer receipts, correct the deposit and clear one bank statement line", async ({ page, browser, baseURL }) => {
  const post = async (path: string, data: object, headers?: Record<string, string>) => {
    const res = await page.request.post("/api/v1" + path, { data, headers });
    await expect(res).toBeOK();
    return res.json();
  };
  await post("/auth/signup", {
    organizationName: "Harbor Deposit Fixture", name: "Pat Sample",
    email: `depositor-${randomUUID()}@example.test`, password: "Deposit-fixture-2026",
  });
  const res = await page.request.get("/api/v1/accounts");
  await expect(res).toBeOK();
  const { data } = await res.json() as { data: { id: string; number: string }[] };
  const bank = data.find((a) => a.number === "1010")!.id;
  const savings = data.find((a) => a.number === "1020")!.id;
  const buyer = await post("/customers", { displayName: "Dockside Design" });
  const receive = (amount: string, date: string, reference: string) => post("/payments", {
    customerId: buyer.id, amount, date, method: "check", reference, applications: [],
  });
  const a = await receive("19.14", "2026-04-02", "CK-14");
  const b = await receive("32.87", "2026-04-03", "CK-25");
  const future = await receive("45.00", "2026-04-25", "CK-40");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Bank Deposits", exact: true }).click();

  async function create(date: string, interruptResponse = false) {
    await page.getByRole("link", { name: "New deposit" }).click();
    await page.getByLabel("Deposit date").fill(date);
    await page.getByLabel("Deposit to").selectOption(bank);
    await page.getByRole("checkbox", { name: a.number, exact: true }).check();
    await page.getByRole("checkbox", { name: b.number, exact: true }).check();
    await expect(page.getByRole("checkbox", { name: future.number, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review deposit" }).click();
    const review = page.getByRole("dialog", { name: "Review bank deposit" });
    await expect(review).toContainText("$52.01");
    await expect(review).toContainText(a.number);
    await expect(review).toContainText(b.number);
    if (interruptResponse) {
      await page.route("**/api/v1/deposits", async route => {
        const posted = await route.fetch();
        await expect(posted).toBeOK();
        await route.abort("failed");
      }, { times: 1 });
    }
    await review.getByRole("button", { name: "Post deposit" }).click();
    if (interruptResponse) {
      await expect(review.getByRole("alert")).toContainText("Posting could not be confirmed");
      await review.getByRole("button", { name: "Retry posting" }).click();
    }
    await expect(page.getByRole("heading", { name: "Included receipts" })).toBeVisible();
    await expect(page.getByRole("link", { name: a.number, exact: true })).toBeVisible();
    return page.url();
  }
  const originalUrl = await create("2026-04-06", true);
  await page.getByRole("button", { name: "Void deposit", exact: true }).click();
  const correction = page.getByRole("dialog", { name: "Void bank deposit" });
  await correction.getByLabel("Reversal date").fill("2026-04-07");
  await correction.getByLabel("Reason for void").fill("Bank slip dated April 7");
  await correction.getByRole("button", { name: "Confirm void" }).click();
  await expect(page.getByRole("heading", { name: "Reversing journal entry" })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Bank Deposits", exact: true }).click();
  const depositUrl = await create("2026-04-07");
  expect(depositUrl).not.toEqual(originalUrl);
  await page.getByRole("link", { name: a.number, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bank deposit history" })).toBeVisible();
  await expect(page.locator(`a[href="${new URL(originalUrl).pathname}"]`)).toBeVisible();
  await page.locator(`a[href="${new URL(depositUrl).pathname}"]`).click();
  const statement = await post("/bank-reconciliations/import", {
    accountId: bank, externalId: "April deposit slip", startDate: "2026-04-01", endDate: "2026-04-30",
    openingBalance: "0.00", closingBalance: "52.01",
    lines: [{ externalId: "BANK-001", date: "2026-04-08", description: "Counter deposit", amount: "52.01" }],
  });
  await page.getByRole("main").getByRole("link", { name: "Bank reconciliation", exact: true }).click();
  await page.getByRole("link", { name: "April deposit slip" }).click();
  const bankRow = page.getByRole("row", { name: /BANK-001/ });
  await bankRow.getByRole("button", { name: "Match", exact: true }).click();
  const match = page.getByRole("dialog", { name: "Match ledger posting" });
  const selector = match.getByLabel("Ledger posting");
  await expect(selector.getByRole("option")).toHaveCount(2);
  await selector.selectOption({ index: 1 });
  await match.getByRole("button", { name: "Confirm match" }).click();
  await page.getByRole("button", { name: "Close statement" }).click();
  await expect(page.getByRole("button", { name: "Reopen statement" })).toBeVisible();
  await page.goto(depositUrl);
  await expect(page.getByRole("link", { name: "View matched statement" })).toHaveAttribute("href", "/bank-reconciliations/" + statement.id);
  await expect(page.getByRole("button", { name: "Void deposit", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  const earlier = await post("/deposits", { bankAccountId: savings, date: "2026-04-26", paymentIds: [future.id] }, { "idempotency-key": randomUUID() });
  const firstSavings = await post("/bank-reconciliations/import", {
    accountId: savings, externalId: "Opening savings", startDate: "2026-05-01", endDate: "2026-05-31",
    openingBalance: "45.00", closingBalance: "45.00", lines: [],
  });
  await post(`/bank-reconciliations/${firstSavings.id}/close`, {});
  await page.goto(`/deposits/${earlier.id}`);
  await expect(page.getByRole("link", { name: "View opening statement" })).toHaveAttribute("href", "/bank-reconciliations/" + firstSavings.id);
  await expect(page.getByRole("button", { name: "Void deposit" })).toHaveCount(0);
  await post(`/bank-reconciliations/${firstSavings.id}/reopen`, {});
  await page.reload();
  await expect(page.getByRole("button", { name: "Void deposit" })).toBeEnabled();

  const viewerEmail = `deposit-viewer-${randomUUID()}@example.test`;
  const password = "Deposit-view-fixture-2026";
  await post("/org/members", { name: "Deposit Reader", email: viewerEmail, temporaryPassword: password, role: "viewer" });
  const viewer = await browser.newContext({ baseURL });
  try {
    await expect(await viewer.request.post("/api/v1/auth/login", { data: { email: viewerEmail, password } })).toBeOK();
    const read = await viewer.newPage();
    await read.goto(depositUrl);
    await expect(read.getByRole("heading", { name: "Included receipts" })).toBeVisible();
    await read.goto("/deposits/new");
    await expect(read.getByText("Bank posting permission is required")).toBeVisible();
    await expect(read.getByRole("button", { name: "Review deposit" })).toHaveCount(0);
  } finally {
    await viewer.close();
  }
});
