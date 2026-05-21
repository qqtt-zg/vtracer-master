const path = require("path");
const { test, expect } = require("@playwright/test");

test("页面可加载并完成一次基础矢量化流程", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#export")).toBeVisible();
  await expect(page.locator("#exportPdf")).toBeVisible();

  const sampleImage = path.resolve(
    __dirname,
    "..",
    "..",
    "public",
    "assets",
    "samples",
    "test-logo.png",
  );

  await page.locator("#imageInput").setInputFiles(sampleImage);
  await page.waitForFunction(
    () => document.querySelectorAll("#svg path").length > 0,
    { timeout: 45000 },
  );

  const pathCount = await page.locator("#svg path").count();
  expect(pathCount).toBeGreaterThan(0);
});
