import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("import, match and close a bank statement with an outstanding check", async ({ page, browser, baseURL }) => {
  const post = async (path: string, data: object) => {
    const response = await page.request.post(`/api/v1${path}`, { data });
    await expect(response).toBeOK();
    return response.json();
  };
  await post("/auth/signup", {
    organizationName: "Bank Statement Fixture", name: "Pat Teller",
    email: `bank-${randomUUID()}@example.test`, password: "Bank-fixture-2026",
  });
  const response = await page.request.get("/api/v1/accounts");
  await expect(response).toBeOK();
  const { data: accounts } = await response.json() as { data: { number: string; id: string }[] };
  const checking = accounts.find((account) => account.number === "1010")!.id;
  const equity = accounts.find((account) => account.number === "3000")!.id;
  await post("/journal-entries", {
    date: "2024-04-12", memo: "Branch deposit", lines: [{ accountId: checking, debit: "125.25" }, { accountId: equity, credit: "125.25" }],
  });
  await post("/journal-entries", {
    date: "2024-04-15", memo: "Check 104", lines: [{ accountId: checking, credit: "40.10" }, { accountId: equity, debit: "40.10" }],
  });
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Bank Reconciliation" }).click();
  const header = "externalId,date,description,amount\r\n";
  const april = `${header}BK-001,2024-04-12,"Branch, deposit",125.25\r\n`;
  async function submitImport(ref: string, start: string, end: string, opening: string, closing: string, csv: string) {
    await page.getByRole("button", { name: "Import statement" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bank account").selectOption(checking);
    await dialog.getByLabel("Statement reference").fill(ref);
    await dialog.getByLabel("Period start").fill(start);
    await dialog.getByLabel("Period end").fill(end);
    await dialog.getByLabel("Opening balance").fill(opening);
    await dialog.getByLabel("Closing balance").fill(closing);
    await dialog.getByLabel("Statement CSV").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await dialog.getByRole("button", { name: "Import statement" }).click();
    await expect(page.getByRole("heading", { name: ref, exact: true })).toBeVisible();
  }
  async function match(bankId: string) {
    await page.getByRole("row", { name: new RegExp(bankId) }).getByRole("button", { name: "Match", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Match ledger posting" });
    await dialog.getByLabel("Ledger posting").selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Confirm match" }).click();
    await expect(dialog).toHaveCount(0);
  }
  const close = page.getByRole("button", { name: "Close statement" });
  const back = page.getByRole("main").getByRole("link", { name: "Bank Reconciliation" });

  await submitImport("April statement", "2024-04-01", "2024-04-30", "0.00", "125.25", april);
  const aprilUrl = page.url();
  await expect(close).toBeDisabled();
  await expect(page.getByText("Branch, deposit", { exact: true })).toBeVisible();
  await match("BK-001");
  await expect(close).toBeEnabled();
  await page.getByRole("button", { name: "Unmatch" }).click();
  await expect(close).toBeDisabled();
  await match("BK-001");
  await expect(page.getByRole("table", { name: "Outstanding ledger postings" })).toContainText("-$40.10");
  await close.click();
  const reopen = page.getByRole("button", { name: "Reopen statement" });
  await expect(reopen).toBeEnabled();
  await reopen.click();
  await expect(close).toBeEnabled();
  await close.click();
  await expect(reopen).toBeEnabled();
  await back.click();
  await submitImport("April statement", "2024-04-01", "2024-04-30", "0.00", "125.25", april);
  await expect(page).toHaveURL(aprilUrl);
  await expect(page.getByRole("table", { name: "Statement transactions" }).getByRole("row")).toHaveCount(2);
  await back.click();
  await submitImport("May draft", "2024-05-01", "2024-05-31", "125.25", "125.25", header);
  await expect(page.getByText("No transactions on this statement.")).toBeVisible();
  await page.getByRole("button", { name: "Discard import" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard statement" }).click();
  await expect(page.getByRole("heading", { name: "Bank Reconciliation", exact: true })).toBeVisible();
  await submitImport("May statement", "2024-05-01", "2024-05-31", "125.25", "85.15", `${header}BK-002,2024-05-03,Check 104,-40.10`);
  await match("BK-002");
  await close.click();
  await expect(reopen).toBeEnabled();
  await page.goto(aprilUrl);
  await expect(reopen).toBeDisabled();
  await expect(page.getByText("Cleared on a later statement")).toBeVisible();
  await expect(page.getByRole("region", { name: "Changes since close" })).toHaveCount(0);
  await post("/journal-entries", {
    date: "2024-04-16", memo: "Late deposit", lines: [{ accountId: checking, debit: "10.00" }, { accountId: equity, credit: "10.00" }],
  });
  await page.reload();
  const changed = page.getByRole("region", { name: "Changes since close" });
  await expect(changed.getByRole("row", { name: /Ledger balance/ }).getByRole("cell")).toHaveText(["$85.15", "$95.15"]);
  await expect(changed.getByRole("link", { name: "Review dated ledger entries" })).toHaveAttribute("href", `/accounts/${checking}?to=2024-04-30`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  const viewerMail = `bank-viewer-${randomUUID()}@example.test`;
  const password = "Bank-view-fixture-2026";
  await post("/org/members", { name: "Bank Reader", email: viewerMail, temporaryPassword: password, role: "viewer" });
  const viewer = await browser.newContext({ baseURL });
  try {
    await expect(await viewer.request.post("/api/v1/auth/login", { data: { email: viewerMail, password } })).toBeOK();
    const read = await viewer.newPage();
    await read.goto("/bank-reconciliations");
    await expect(read.getByRole("button", { name: "Import statement" })).toHaveCount(0);
    await read.getByRole("link", { name: "April statement", exact: true }).click();
    await expect(read.getByText("Cleared on a later statement")).toBeVisible();
    await expect(read.getByRole("button", { name: "Reopen statement" })).toHaveCount(0);
  } finally {
    await viewer.close();
  }
});
