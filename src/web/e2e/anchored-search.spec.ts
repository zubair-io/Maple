// AnchoredOverlay + tablet/desktop Search e2e — deferred until S7 (#629) merges.
//
// This file is the parked Playwright contract for the search-overlay flow
// spec'd in docs/design/responsive-program/s7-search.md §2:
//   - tablet (≥768px): sidebar search pill opens a 320pt overlay
//     anchored below the pill; main pane is dimmed 25%, sidebar stays
//     bright. Esc + outside-click dismiss.
//   - desktop (≥1280px): 480pt overlay; main 25% + inspector 35%.
//
// Skipped today because the host wiring lives in the sibling PR #629
// (S7). #629 ships `<app-search>`; this PR (#645) ships the overlay
// primitive + the sidebar pill that triggers it with a placeholder host.
// Until both land, asserting "type a query, results render" cannot run
// against any single revision.
//
// When #629 merges, drop the `.skip` and update the selector for the
// real `<app-search>` input.

import { test, expect } from '@playwright/test';

test.describe('Anchored search overlay — tablet/desktop', () => {
  test.skip(
    true,
    'Skipped pending S7 (#629) merge — the placeholder host in this PR is intentionally a stub.',
  );

  test('tablet (800px): pill opens overlay anchored below; outside-click dismisses', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 1024 });
    await page.goto('/');

    // Click the sidebar's search pill.
    await page.getByTestId('sidebar-search-pill').click();

    const overlay = page.getByTestId('anchored-overlay');
    await expect(overlay).toBeVisible();
    // Overlay sits below the pill (top of overlay > bottom of pill).
    const pillBox = await page.getByTestId('sidebar-search-pill').boundingBox();
    const overlayBox = await overlay.boundingBox();
    if (!pillBox || !overlayBox) throw new Error('missing bounding box');
    expect(overlayBox.y).toBeGreaterThan(pillBox.y + pillBox.height);
    // Overlay width = 320 (tablet token).
    expect(overlayBox.width).toBeCloseTo(320, 0);

    // Type a query — assertion against `<app-search>` results lands when
    // S7 merges. For now the placeholder host renders a text input.
    await page.getByTestId('overlay-search-input').fill('paris');
    // Results assertion stub:
    // await expect(page.getByTestId('search-results')).toBeVisible();

    // Click outside the overlay (main pane area) — overlay closes.
    await page.mouse.click(600, 400);
    await expect(overlay).not.toBeVisible();
  });

  test('desktop (1400px): overlay is 480px wide; scrim covers main + inspector', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');

    await page.getByTestId('sidebar-search-pill').click();
    const overlay = page.getByTestId('anchored-overlay');
    await expect(overlay).toBeVisible();

    const overlayBox = await overlay.boundingBox();
    if (!overlayBox) throw new Error('missing bounding box');
    expect(overlayBox.width).toBeCloseTo(480, 0);

    // Both scrims rendered.
    await expect(page.locator('.scrim-main')).toBeVisible();
    await expect(page.locator('.scrim-inspector')).toBeVisible();

    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible();
  });
});
