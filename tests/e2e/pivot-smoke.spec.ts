import { expect, test, type Page } from "@playwright/test";

async function dragFieldToZone(page: Page, fieldLabel: string, zoneLabel: string) {
  const source = page.getByRole("listitem", { name: `Field ${fieldLabel}` });
  const target = page.getByRole("list", { name: `${zoneLabel} aktif` });

  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(`Cannot drag ${fieldLabel}; source or target box is unavailable.`);
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2 + 8);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 12,
  });

  await expect(target.locator(".analytics-selected-drop-preview").filter({ hasText: fieldLabel })).toBeVisible();
  await page.mouse.up();

  await expect(page.getByRole("listitem", { name: `${zoneLabel} ${fieldLabel}` })).toBeVisible();
}

test("pivot analytics field workflow renders across pivot, bar, and donut modes", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Pivot/Grafik" }).click();

  await expect(page.getByLabel("Panel Aksi Pivot Grafik")).toBeVisible();
  await expect(page.getByLabel("Panel Utama Pivot Grafik")).toBeVisible();
  await expect(page.getByLabel("Mode Pivot Grafik")).toHaveValue("pivot");

  await dragFieldToZone(page, "Jenis Layanan", "Row");
  await dragFieldToZone(page, "Status Akhir", "Column");
  await dragFieldToZone(page, "Nomor Kiriman", "Value");

  await expect(page.getByLabel("Mode Value Nomor Kiriman")).toBeVisible();
  await expect(page.getByRole("region", { name: "Tabel Pivot" })).toBeVisible();
  await expect(page.locator(".analytics-summary-table")).toBeVisible();

  const analyticsScreenshot = await page.locator(".sheet-analytics-view").screenshot();
  expect(analyticsScreenshot.byteLength).toBeGreaterThan(10_000);

  await page.getByLabel("Mode Pivot Grafik").selectOption("bar");
  await expect(page.getByRole("region", { name: "Grafik Pivot" })).toBeVisible();

  await page.getByLabel("Mode Pivot Grafik").selectOption("donut");
  await expect(page.getByRole("region", { name: "Grafik Pivot" })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
