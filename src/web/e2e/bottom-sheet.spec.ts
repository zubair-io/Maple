// Bottom-sheet drag-to-dismiss e2e (#599 / S1c follow-up).
//
// Playwright contract for the pan-down dismiss behaviour spec'd in
// docs/design/responsive-program/s1-phone-shell.md §4.2:
//   - drag distance ≥ 25% of sheet height → dismiss
//   - pointer velocity ≥ 1000 px/s at release → dismiss
//
// The unit spec (bottom-sheet.component.spec.ts) covers the DOM contract;
// drag logic is jsdom-hostile (no real PointerEvents) so it needs a real
// browser. Consumer page: the Editor's Presets sheet (#1115).

import { expect, test } from '@playwright/test';

test.describe('Bottom-sheet — drag-to-dismiss', () => {
  test.beforeEach(async ({ page }) => {
    // Force phone layout per LayoutService thresholds (< 768px).
    await page.setViewportSize({ width: 375, height: 812 });

    // Navigate directly to the editor route. Playwright runs the Hosted
    // (maple-syrup) app which has no auth gate, so no sign-in step needed.
    await page.goto('/library/editor/e2e-test-asset');

    // Switch to the 'Detail' group where the Presets pill lives.
    await page.getByTestId('editor-group-detail').click();

    // Open the Presets bottom sheet.
    await page.getByTestId('editor-tool-presets').click();

    // Verify the bottom sheet is visible before each test.
    await expect(page.getByTestId('bottom-sheet')).toBeVisible();
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
    // Use many small steps spread across 500ms so the computed velocity
    // stays well below DISMISS_VELOCITY (1000 px/s), ensuring dismissal
    // is driven by distance — not velocity.
    const dragDistance = box.height * 0.3;
    const steps = 30;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(startX, startY + (dragDistance * i) / steps);
      // ~17ms per step → total ~500ms for the full drag (360 px/s peak ≪ 1000 px/s)
      await page.waitForTimeout(17);
    }
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

    // Fast flick: 150px in a single step with no delay → gesture completes
    // in a few ms, giving a velocity well above DISMISS_VELOCITY (1000 px/s).
    // Using 150px (vs the original 50px) gives headroom: even at 100ms the
    // implied velocity is 1500 px/s, safely above the threshold.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 150, { steps: 1 });
    await page.mouse.up();

    await expect(sheet).not.toBeVisible();
  });
});
