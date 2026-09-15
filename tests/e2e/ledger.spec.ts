import { expect, test } from "@playwright/test";

// Critical points only: what a reader of the ledger would notice if it broke.

test("the ledger is honest that it shows sample data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "What each ticket cost to build with AI" })).toBeVisible();
  await expect(page.getByText("Sample data")).toBeVisible();
});

test("the ledger shows how much Claude Code spend the tickets explain", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Attributed", { exact: true })).toBeVisible();
  await expect(page.getByText(/of \$[\d,.]+ Claude Code spend/)).toBeVisible();
});

test("tickets are listed most expensive first and open their detail", async ({ page }) => {
  await page.goto("/");
  const rows = page.getByRole("row");
  // Row 0 is the header. The sample's most expensive ticket leads.
  await expect(rows.nth(1)).toContainText("TPT-23");

  await rows.nth(1).getByRole("link").click();
  await expect(page).toHaveURL(/\/tickets\/TPT-23/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("TPT-23");
  await expect(page.getByRole("img", { name: /Spend per active day/ })).toBeVisible();
  await expect(page.getByText("claude-sonnet-5", { exact: true })).toBeVisible();
});

test("the ticket page previews the Linear comment with the ticket's tag", async ({ page }) => {
  await page.goto("/tickets/TPT-23");
  const preview = page.locator("pre");
  await expect(preview).toContainText("AI development spend · TPT-23");
  await expect(preview).toContainText("ticket:TPT-23");
  // TPT-23's sample spend starts well inside 30 days, so the report is whole.
  await expect(preview).not.toContainText("earlier spend may be missing");
});

test("the range picker changes the window and marks the current choice", async ({ page }) => {
  await page.goto("/");
  const range = page.getByRole("navigation", { name: "Date range" });
  await expect(range.getByRole("link", { name: "30 days" })).toHaveAttribute("aria-current", "page");
  await range.getByRole("link", { name: "7 days" }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(range.getByRole("link", { name: "7 days" })).toHaveAttribute("aria-current", "page");
});

test("a ticket with no spend says what to check", async ({ page }) => {
  await page.goto("/tickets/TPT-999");
  await expect(page.getByText("No spend recorded for TPT-999 in this range")).toBeVisible();
  await expect(page.getByText(/the branch names TPT-999/)).toBeVisible();
});

test("a path that isn't a ticket key is a 404", async ({ page }) => {
  const response = await page.goto("/tickets/not-a-ticket");
  expect(response?.status()).toBe(404);
});
