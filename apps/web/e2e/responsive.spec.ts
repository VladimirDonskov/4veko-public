import { expect, test } from "@playwright/test";

// Phone-width checks: no sideways page scroll, and navigation works through the menu.
test("works at phone width", async ({ page }) => {
  const run = Date.now().toString(36);
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Pat Phone");
  await page.getByLabel("Work email").fill(`mobile-${run}@example.test`);
  await page.getByLabel("Password").fill("Mobile-password-2026");
  await page.getByLabel("Company name").fill(`Mobile Co ${run}`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  for (const path of ["/dashboard", "/invoices", "/sales-orders/new", "/purchase-orders/new", "/bills/new", "/bill-payments/new", "/reports/balance-sheet", "/reports/control-reconciliation", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal page scroll on ${path}`).toBeLessThanOrEqual(0);
  }

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Chart of Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Chart of Accounts" })).toBeVisible();
});
