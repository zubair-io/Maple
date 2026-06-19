// Bottom-sheet drag-to-dismiss e2e — deferred (#599 / S1c follow-up).
//
// This file is the Playwright contract for the pan-down dismiss
// behaviour spec'd in responsive-program-s1-phone-shell.md §4.2:
//   - drag distance ≥ 25% of sheet height → dismiss
//   - pointer velocity ≥ 1000 px/s at release → dismiss

import { expect, test } from '@playwright/test';

test.describe('Bottom-sheet — drag-to-dismiss', () => {
  test.beforeEach(async ({ page }) => {
    // Force phone layout per LayoutService thresholds (< 768px).
    await page.setViewportSize({ width: 375, height: 812 });
    // Navigate to a route that mounts <app-bottom-sheet> — the Editor's
    // Presets sheet is the first consumer to land (#1115).
    await page.goto('/library/editor/e2e-test-asset');

    // Switch to 'Detail' group where Presets pill lives.
    await page.getByTestId('editor-group-detail').click();
  });

  test('dismisses on pan-down ≥ 25% sheet height', async ({ page }) => {
    // Open the sheet via the Presets tool pill.
    await page.getByTestId('editor-tool-presets').click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toBeVisible();

    const dragArea = page.locator('.drag-area');
    const sheetBox = await sheet.boundingBox();
    const dragBox = await dragArea.boundingBox();

    if (!sheetBox || !dragBox) throw new Error('Sheet/drag-area not found');

    const startX = dragBox.x + dragBox.width / 2;
    const startY = dragBox.y + dragBox.height / 2;

    // Pan down 30% — threshold is 25% (§4.2).
    const endY = startY + sheetBox.height * 0.3;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move slowly to avoid triggering the velocity threshold (1000 px/s).
    // 30% of 74vh (812px height) is ~180px. 500ms for 180px is ~360 px/s.
    await page.mouse.move(startX, endY, { steps: 20 });
    await page.mouse.up();

    await expect(sheet).not.toBeVisible();
  });

  test('dismisses on flick (velocity ≥ 1000 px/s)', async ({ page }) => {
    // Open the sheet.
    await page.getByTestId('editor-tool-presets').click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toBeVisible();

    const dragArea = page.locator('.drag-area');
    const dragBox = await dragArea.boundingBox();
    if (!dragBox) throw new Error('Drag area not found');

    const startX = dragBox.x + dragBox.width / 2;
    const startY = dragBox.y + dragBox.height / 2;

    // Fast flick: move 50px in one step.
    const endY = startY + 50;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // One step is very fast, triggering the velocity threshold.
    await page.mouse.move(startX, endY, { steps: 1 });
    await page.mouse.up();

    await expect(sheet).not.toBeVisible();
  });
});
