import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The golden path from the brief, entirely through the UI, in a brand-new
// organization: customer → sales order → invoice → payment → receivables →
// General Ledger → dashboard. Accessibility is scanned on each main screen.

const run = Date.now().toString(36);
const email = `e2e-${run}@example.test`;
const password = "E2E-password-2026";
const sku = `E2E-${run}`.toUpperCase();
const customer = `E2E Customer ${run}`;

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) – ${v.help}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("order to cash, end to end", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("response", (r) => r.status() >= 500 && consoleErrors.push(`${r.status()} ${r.url()}`));

  await test.step("sign up and create the company", async () => {
    await page.goto("/signup");
    await axe(page, "sign up");
    await page.getByLabel("Your name").fill("Erin Example");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByLabel("Company name").fill(`E2E Supply ${run}`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("Get set up in a few minutes")).toBeVisible();
    await axe(page, "empty dashboard");
  });

  await test.step("create a customer", async () => {
    await page.goto("/customers?new=1");
    await page.getByLabel("Display name").fill(customer);
    await page.getByLabel("Email").fill("buyer@example.test");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: customer })).toBeVisible();
  });

  await test.step("create a stocked product and enter opening stock", async () => {
    await page.goto("/items?new=1");
    await page.getByLabel("SKU").fill(sku);
    await page.getByRole("textbox", { name: /^Name\b/ }).fill("Test Widget");
    await page.getByLabel("Sales price").fill("25.00");
    await page.getByLabel("Purchase cost").fill("10.00");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Test Widget" })).toBeVisible();

    await page.goto("/inventory?adjust=1");
    await page.getByLabel("Line 1 item").selectOption({ label: `${sku} · Test Widget (0 on hand)` });
    await page.getByLabel("Line 1 quantity change").fill("10");
    await page.getByLabel("Line 1 unit cost").fill("10.00");
    await page.getByRole("button", { name: "Post adjustment" }).click();
    await expect(page.getByText(/Adjustment ADJ-\d+ posted/)).toBeVisible();
  });

  await test.step("create a sales order and invoice it in one step", async () => {
    await page.goto("/sales-orders/new");
    await page.getByRole("combobox", { name: /^Customer/ }).selectOption({ label: customer });
    await page.getByLabel("Line 1 item").selectOption({ label: `${sku} · Test Widget` });
    await page.getByLabel("Line 1 quantity").fill("2");
    await expect(page.getByText("$50.00").first()).toBeVisible();
    await axe(page, "new sales order");
    await page.getByRole("button", { name: "Save and invoice" }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: /Invoice INV-\d+/ })).toBeVisible();
    await expect(page.getByText("Open", { exact: true })).toBeVisible();
    // The ledger impact is shown on the invoice: AR, revenue, COGS and inventory.
    await expect(page.getByRole("link", { name: /1200 Accounts Receivable/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /5000 Cost of Goods Sold/ })).toBeVisible();
    await axe(page, "invoice");
  });

  await test.step("record the customer's payment", async () => {
    await page.getByRole("link", { name: "Record payment" }).click();
    await expect(page.getByLabel("Amount received")).toHaveValue("50.00");
    await page.getByLabel("Reference").fill("CHK-1042");
    await axe(page, "record payment");
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByRole("heading", { name: /Payment PMT-\d+/ })).toBeVisible();
    await page.getByRole("link", { name: /INV-\d+/ }).first().click();
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  });

  await test.step("receivables are cleared and the ledger balances", async () => {
    await page.goto("/reports/ar-aging");
    await expect(page.getByText("No open customer balances on this date.")).toBeVisible();

    await page.goto("/reports/trial-balance");
    await expect(page.getByText("Debits equal credits.")).toBeVisible();
    await axe(page, "trial balance");

    await page.goto("/journal");
    await expect(page.getByText(/Invoice INV-\d+ to/)).toBeVisible();
    await expect(page.getByText(/Payment PMT-\d+ from/)).toBeVisible();

    await page.goto("/reports/balance-sheet");
    await expect(page.getByText("Assets equal liabilities plus equity.")).toBeVisible();
  });

  await test.step("the dashboard reflects the sale", async () => {
    await page.goto("/dashboard");
    const revenue = page.getByText("Revenue this month").locator("..");
    await expect(revenue).toContainText("$50.00");
    const ar = page.getByText("Accounts receivable", { exact: true }).locator("..");
    await expect(ar).toContainText("$0.00");
    await axe(page, "dashboard");
  });

  expect(consoleErrors, "browser console errors or 5xx responses").toEqual([]);
});

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/invoices");
  await expect(page).toHaveURL(/\/login\?next=%2Finvoices/);
  await axe(page, "sign in");
});
