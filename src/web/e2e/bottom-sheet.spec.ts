// Bottom-sheet drag-to-dismiss e2e — deferred (#599 / S1c follow-up).
//
// This file is the parked Playwright contract for the pan-down dismiss
// behaviour spec'd in responsive-program-s1-phone-shell.md §4.2:
//   - drag distance ≥ 25% of sheet height → dismiss
//   - pointer velocity ≥ 1000 px/s at release → dismiss
//
// It's skipped today because S1c ships only the primitive — no consumer
// page mounts `<app-bottom-sheet>` until S4 Loupe / S5 Editor / S6 phone
// Detail land. The unit spec (bottom-sheet.component.spec.ts) covers DOM
// contract; drag logic is jsdom-hostile (no real PointerEvents) so it
// needs a real browser.
//
// When S4 or S5 mounts the primitive on a route, unskip and target that
// route. Suggested host: a Loupe route phone-mode opening Info from the
// toolbar.

import { expect, test } from '@playwright/test';

test.describe('Bottom-sheet — drag-to-dismiss', () => {
  test.beforeEach(async ({ page }) => {
    // Phone viewport (iPhone X/11/12/13/14)
    await page.setViewportSize({ width: 375, height: 812 });

    // Bypass auth using the dev login route.
    await page.goto('/sign-in');
    const devBtn = page.getByRole('button', { name: /dev login/i });
    if (await devBtn.isVisible()) {
      await devBtn.click();
      await page.waitForURL('/browse');
    }

    // Navigate to the editor page for a mock image.
    await page.goto('/library/editor/test-image-123');

    // Switch to the 'detail' group where 'presets' tool lives.
    const detailTab = page.getByTestId('editor-group-detail');
    await detailTab.waitFor({ state: 'attached' });
    await detailTab.click();

    // Open the Presets bottom sheet.
    // Wait for the pill to be attached to the DOM.
    const presetsPill = page.getByTestId('editor-tool-presets');
    await presetsPill.waitFor({ state: 'attached' });
    await presetsPill.click();

    // Verify the bottom sheet is open.
    const sheet = page.getByTestId('bottom-sheet');
    await expect(sheet).toBeVisible();
  });

  test('dismisses on pan-down ≥ 25% sheet height', async ({ page }) => {
    const sheet = page.getByTestId('bottom-sheet');
    const dragArea = page.getByTestId('bottom-sheet-drag-area');

    const box = await sheet.boundingBox();
    if (!box) throw new Error('sheet has no bounding box');

    const dragAreaBox = await dragArea.boundingBox();
    if (!dragAreaBox) throw new Error('drag-area has no bounding box');

    const startX = dragAreaBox.x + dragAreaBox.width / 2;
    const startY = dragAreaBox.y + dragAreaBox.height / 2;

    // Pan-down 30% of the sheet height (past the 25% threshold).
    const dragDistance = box.height * 0.3;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + dragDistance, { steps: 10 });
    await page.mouse.up();

    await expect(sheet).not.toBeVisible();
  });

  test('dismisses on flick (velocity ≥ 1000 px/s)', async ({ page }) => {
    const sheet = page.getByTestId('bottom-sheet');
    const dragArea = page.getByTestId('bottom-sheet-drag-area');

    const dragAreaBox = await dragArea.boundingBox();
    if (!dragAreaBox) throw new Error('drag-area has no bounding box');

    const startX = dragAreaBox.x + dragAreaBox.width / 2;
    const startY = dragAreaBox.y + dragAreaBox.height / 2;

    // Fast flick: short distance, but very fast.
    // DISMISS_VELOCITY = 1000 px/s.
    // If we move 50px in 10ms, velocity = 50 / 0.01 = 5000 px/s.
    // page.mouse.move with steps: 1 doesn't guarantee timing, but a single
    // large move followed by up is usually interpreted as a flick in Playwright.

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move 50px down in one step to simulate high velocity.
    await page.mouse.move(startX, startY + 50);
    await page.mouse.up();

    await expect(sheet).not.toBeVisible();
  });
});
