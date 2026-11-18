import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function edit(page: Page, source: string) {
  await page.waitForFunction(() => window.monaco?.editor.getModels().length === 1);
  await page.evaluate(source => window.monaco!.editor.getModels()[0].setValue(source), source);
}

test("publish reviewed source through the real gateway and browse the published metadata", async ({ page, browser, baseURL }) => {
  const stamp = Date.now().toString(36);
  const password = "Studio-fixture-2026!";
  const signup = await page.request.post("/api/v1/auth/signup", { data: {
    name: "Studio Owner", email: `studio-${stamp}@example.test`, password, organizationName: `Studio test ${stamp}`,
  } });
  expect(signup.ok()).toBe(true);
  await page.goto("/studio");
  await expect(page.getByRole("link", { name: "New application" })).toBeVisible();
  const listScan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(listScan.violations).toEqual([]);
  await page.getByRole("link", { name: "New application" }).click();
  await page.getByLabel("Application name").fill("service");
  await edit(page, "catalog {");
  await page.getByRole("button", { name: "Check and review" }).click();
  await expect(page.getByRole("button", { name: /Error at/ }).first()).toBeVisible();
  const v1 = "catalog Clients { field name: String(60) required; field phone: String(20); }";
  await edit(page, v1);
  await page.getByRole("button", { name: "Check and review" }).click();
  await expect(page.getByText("Create catalog Clients")).toBeVisible();
  const reviewScan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(reviewScan.violations).toEqual([]);
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await expect(page).toHaveURL(/\/studio\/app\/service$/);
  await expect(page.getByText("Published version 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.monaco?.editor.getModels()[0]?.getValue())).toBe(v1);

  const stale = await page.context().newPage();
  await stale.goto("/studio/app/service");
  await edit(stale, v1 + "\n// concurrent edit");
  await stale.getByRole("button", { name: "Check and review" }).click();
  await expect(stale.getByRole("button", { name: "Publish version 2" })).toBeEnabled();

  const v2 = "catalog Clients { field name: String(60) required; }";
  await edit(page, v2);
  await page.getByRole("button", { name: "Check and review" }).click();
  await expect(page.getByRole("button", { name: "Publish version 2" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I approve" }).check();
  await edit(page, v2 + "\n");
  await expect(page.getByRole("button", { name: "Publish version 2" })).toHaveCount(0);
  await page.getByRole("button", { name: "Check and review" }).click();
  await page.getByRole("checkbox", { name: "I approve" }).check();
  await page.getByRole("button", { name: "Publish version 2" }).click();
  await expect(page.getByText("Published version 2", { exact: true })).toBeVisible();
  await stale.getByRole("button", { name: "Publish version 2" }).click();
  await expect(stale.getByRole("alert").filter({ hasText: "active version is 2" })).toBeVisible();
  await stale.close();
  const active = await page.request.get("/api/v1/platform/apps/service/source");
  expect(await active.json()).toMatchObject({ version: 2, source: v2 + "\n" });

  const viewerMail = `reader-${stamp}@example.test`;
  const member = await page.request.post("/api/v1/org/members", { data: { name: "Studio Reader", email: viewerMail, role: "viewer", temporaryPassword: password } });
  expect(member.ok()).toBe(true);
  const viewer = await browser.newContext({ baseURL });
  try {
    const login = await viewer.request.post("/api/v1/auth/login", { data: {email: viewerMail, password} });
    expect(login.ok()).toBe(true);
    const read = await viewer.newPage();
    await read.goto("/studio");
    await expect(read.getByRole("link", { name: "New application" })).toHaveCount(0);
    await read.getByRole("link", { name: /service.*Version 2/ }).click();
    await expect(read.getByText("Clients", { exact: true })).toBeVisible();
    await expect(read.getByRole("button", { name: "Check and review" })).toHaveCount(0);
    expect((await viewer.request.get("/api/v1/platform/apps/service/source")).status()).toBe(403);
  } finally {
    await viewer.close();
  }
});
