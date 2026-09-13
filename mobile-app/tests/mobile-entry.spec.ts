import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("手机端入口和应用页都能完成首屏渲染", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#root .download-page")).toBeVisible();

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "登录 Alpha Trader AI" })).toBeVisible();
  await expect(page.getByLabel("登录账号")).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeDisabled();
  await expect(page.locator("#root")).not.toBeEmpty();
});
