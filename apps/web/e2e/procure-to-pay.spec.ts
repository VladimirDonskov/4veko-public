import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Procure to pay through the UI in a new organization: vendor → purchase
// order → partial receipt → bill (price variance) → payment → payables.

const run = Date.now().toString(36);
const sku = `P2P-${run}`.toUpperCase();
const vendor = `E2E Supplier ${run}`;

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) – ${v.help}`),
    `axe violations on ${label}`,
  ).toEqual([]);
}

test("procure to pay, end to end", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("response", (r) => r.status() >= 500 && problems.push(`${r.status()} ${r.url()}`));

  await test.step("sign up, add a vendor and a stocked item", async () => {
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Pat Purchaser");
    await page.getByLabel("Work email").fill(`p2p-${run}@example.test`);
    await page.getByLabel("Password").fill("P2P-password-2026");
    await page.getByLabel("Company name").fill(`P2P Co ${run}`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto("/vendors?new=1");
    await page.getByLabel("Display name").fill(vendor);
    await page.getByLabel("Payment terms (days)").fill("30");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: vendor })).toBeVisible();

    await page.goto("/items?new=1");
    await page.getByLabel("SKU").fill(sku);
    await page.getByRole("textbox", { name: /^Name\b/ }).fill("Bulk Gadget");
    await page.getByLabel("Sales price").fill("30.00");
    await page.getByLabel("Purchase cost").fill("12.00");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Bulk Gadget" })).toBeVisible();
  });

  await test.step("create and issue a purchase order", async () => {
    await page.goto("/purchase-orders/new");
    await page.getByRole("combobox", { name: /^Vendor/ }).selectOption({ label: vendor });
    await page.getByLabel("Line 1 item").selectOption({ label: `${sku} · Bulk Gadget` });
    await expect(page.getByLabel("Line 1 unit cost")).toHaveValue("12");
    await page.getByLabel("Line 1 quantity").fill("10");
    await expect(page.getByText("$120.00").first()).toBeVisible();
    await axe(page, "new purchase order");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("heading", { name: /PO-\d+/ })).toBeVisible();
    await page.getByRole("button", { name: "Issue to vendor" }).click();
    await expect(page.getByText("Issued", { exact: true })).toBeVisible();
  });

  await test.step("receive part of the order into stock", async () => {
    await page.getByRole("button", { name: "Receive items" }).click();
    await page.getByLabel(`Quantity received for ${sku}`).fill("6");
    await page.getByRole("button", { name: "Receive into stock" }).click();
    await expect(page.getByText(/Receipt RCV-\d+ posted/)).toBeVisible();
    await expect(page.getByText("Partially received", { exact: true })).toBeVisible();
    await axe(page, "purchase order");
  });

  await test.step("enter the vendor's bill at a slightly higher price", async () => {
    await page.getByRole("link", { name: "Enter bill" }).click();
    await page.getByLabel("Vendor invoice number").fill(`INV-${run}`);
    await expect(page.getByLabel(`Quantity to bill for ${sku}`)).toHaveValue("6");
    await page.getByLabel(`Unit cost for ${sku}`).fill("12.50");
    await expect(page.getByText("$75.00").first()).toBeVisible();
    await axe(page, "enter bill");
    await page.getByRole("button", { name: "Enter bill" }).click();
    await expect(page.getByRole("heading", { name: /Bill BILL-\d+/ })).toBeVisible();
    // Ledger impact: accrual cleared at order cost, variance booked, payable credited.
    await expect(page.getByRole("link", { name: /2050 Received Not Billed/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /5200 Purchase Price Variance/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /2000 Accounts Payable/ })).toBeVisible();
    await axe(page, "bill");
  });

  await test.step("the same vendor invoice cannot be entered twice", async () => {
    await page.goto("/bills/new");
    await page.getByRole("combobox", { name: /^Vendor/ }).selectOption({ label: vendor });
    await page.getByLabel("Vendor invoice number").fill(`inv-${run}`);
    await page.getByRole("button", { name: "Add expense line" }).click();
    await page.getByLabel("Expense line 1 account").selectOption({ label: "6300 Office Supplies" });
    await page.getByLabel("Expense line 1 amount").fill("10.00");
    await page.getByRole("button", { name: "Enter bill" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already been entered for this vendor" })).toBeVisible();
  });

  await test.step("pay the bill", async () => {
    await page.goto("/bills?status=unpaid");
    await page.getByRole("row", { name: new RegExp(`INV-${run}`, "i") }).click();
    await expect(page.getByRole("heading", { name: /Bill BILL-\d+/ })).toBeVisible();
    await page.getByRole("link", { name: "Pay bill", exact: true }).click();
    await expect(page.getByLabel(/Amount for BILL-\d+/)).toHaveValue("75.00");
    await page.getByLabel("Reference").fill("ACH-77");
    await axe(page, "pay bills");
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByRole("heading", { name: /Bill payment BP-\d+/ })).toBeVisible();
    await page.getByRole("link", { name: /BILL-\d+/ }).click();
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  });

  await test.step("payables are clear, the accrual holds the unbilled receipt, books balance", async () => {
    await page.goto("/reports/ap-aging");
    await expect(page.getByText("No open vendor balances on this date.")).toBeVisible();
    await page.goto("/reports/trial-balance");
    await expect(page.getByText("Debits equal credits.")).toBeVisible();
    // 6 received and billed: nothing left in Received Not Billed.
    await expect(page.getByRole("link", { name: /2050 Received Not Billed/ })).toHaveCount(0);
    await page.goto("/reports/balance-sheet");
    await expect(page.getByText("Assets equal liabilities plus equity.")).toBeVisible();
    await page.goto("/dashboard");
    await expect(page.getByText("Accounts payable", { exact: true }).locator("..")).toContainText("$0.00");
    await axe(page, "dashboard with payables");
  });

  expect(problems.filter((p) => !p.includes("409")), "console errors or 5xx").toEqual([]);
});
