// #4674 — the inline "Delete …?" confirm row must be clickable with real
// hit-testing. jsdom ignores CSS, so only a browser can catch a
// `pointer-events: none` ancestor swallowing the Confirm/Cancel clicks.

import { expect, test } from '@playwright/test';

test.describe('Presets panel — inline delete confirm', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/maple-ui');
    await page.getByRole('tab', { name: '4 Organisms' }).click();
    await page.getByTestId('preset-delete-p1').scrollIntoViewIfNeeded();
    await page.getByTestId('preset-delete-p1').click();
    await expect(page.getByTestId('preset-delete-confirm-row-p1')).toBeVisible();
  });

  test('Cancel is clickable and returns the row to its normal state', async ({ page }) => {
    await page.getByTestId('preset-delete-cancel-p1').click({ timeout: 5_000 });
    await expect(page.getByTestId('preset-delete-confirm-row-p1')).toHaveCount(0);
    await expect(page.getByTestId('preset-apply-p1')).toBeVisible();
  });

  test('Confirm is clickable', async ({ page }) => {
    await page.getByTestId('preset-delete-confirm-p1').click({ timeout: 5_000 });
    await expect(page.getByTestId('preset-delete-confirm-row-p1')).toHaveCount(0);
  });

  test('Enter on the focused Confirm button activates it, not the row', async ({ page }) => {
    await page.getByTestId('preset-delete-confirm-p1').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('preset-delete-confirm-row-p1')).toHaveCount(0);
  });
});
