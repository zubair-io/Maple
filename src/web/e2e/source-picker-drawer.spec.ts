// SourcePickerDrawer — pan-to-dismiss e2e.
//
// Skipped until S1a (phone-tab-shell) integrates the drawer into a real
// route. The component itself ships in maple-common as part of S1b
// (ticket #598); pan-gesture coverage moves here because jsdom can't
// dispatch PointerEvents the way Chromium does (pointer capture +
// touch-action interactions).
//
// When S1a lands, drop the `.skip`, point the route at the integrated
// phone Library tab, and uncomment the dismiss assertion.

import { test, expect } from '@playwright/test';

test.describe('SourcePickerDrawer — pan-left dismiss', () => {
  test.skip(
    true,
    'Skipped pending S1a integration — drawer is not yet mounted on any maple-syrup route.',
  );

  test('drag-left past 30% width closes the drawer', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 375, height: 812 });

    // Open the drawer via the Library tab's hamburger (S1a wiring).
    await page.getByRole('button', { name: /library/i }).click();
    const drawer = page.getByTestId('source-picker-drawer');
    await expect(drawer).toBeVisible();

    // Pan-left 50% of the drawer width — well past the 30% dismiss
    // threshold. Use page.mouse so the gesture goes through the same
    // PointerEvents pipeline the component listens on.
    const box = await drawer.boundingBox();
    if (!box) throw new Error('drawer has no bounding box');
    const startX = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - box.width * 0.5, y, { steps: 10 });
    await page.mouse.up();

    await expect(drawer).not.toBeVisible();
  });
});
