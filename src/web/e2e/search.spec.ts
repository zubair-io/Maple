// Search — unified search page (#2865) e2e.
//
// Verifies `<app-search>` renders on `/search`, focuses with
// `?autoFocus=1`, drives the Date/People/Places filter model, and
// persists recents across navigations. The e2e backend doesn't serve a
// real search index, so we don't assert on response data — just on UI
// scaffold, filter state, and recents behaviour.

import { expect, test } from '@playwright/test';

test.describe('Search — phone tab content', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Clean slate so recents assertions are deterministic.
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('cm.search.recent'));
  });

  test('renders search root and the Filters control on /search', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByTestId('search-root')).toBeVisible();
    await expect(page.getByTestId('search-filters')).toBeVisible();
  });

  test('Filters opens the sheet with Date/People/Places sections and presets toggle', async ({
    page,
  }) => {
    await page.goto('/search');
    await page.getByTestId('search-filters').click();
    await expect(page.getByTestId('filter-panel')).toBeVisible();
    const preset = page.getByTestId('filter-preset-last30');
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    // The active-filter chip surfaces in the bar and the badge counts 1.
    await page.getByTestId('filter-close').click();
    await expect(page.getByTestId('search-active-chip')).toBeVisible();
    await expect(page.getByTestId('search-filter-count')).toHaveText('1');
    // Removing the chip clears the filter.
    await page.getByTestId('search-chip-remove-Last 30 days').click();
    await expect(page.getByTestId('search-active-chip')).not.toBeVisible();
  });

  test('auto-focuses the search input when ?autoFocus=1', async ({ page }) => {
    await page.goto('/search?autoFocus=1');
    const input = page.getByTestId('search-input');
    await expect(input).toBeFocused();
  });

  test('shows clear button once query is typed and removes it on clear', async ({ page }) => {
    await page.goto('/search');
    const input = page.getByTestId('search-input');
    await input.fill('paris');
    await expect(page.getByTestId('search-clear')).toBeVisible();
    await page.getByTestId('search-clear').click();
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('search-clear')).not.toBeVisible();
  });

  test('persists recents to localStorage on submit', async ({ page }) => {
    await page.goto('/search');
    const input = page.getByTestId('search-input');
    await input.fill('paris');
    await input.press('Enter');
    // Recents render only when the input is empty.
    await page.getByTestId('search-clear').click();
    await expect(page.getByTestId('recent-queries-section')).toBeVisible();
    await expect(page.getByTestId('recent-chip-paris')).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem('cm.search.recent'));
    expect(stored).toBe(JSON.stringify(['paris']));
  });

  test('typing a trailing @ opens the tag picker', async ({ page }) => {
    await page.goto('/search');
    const input = page.getByTestId('search-input');
    await input.fill('@');
    await expect(page.getByTestId('tag-picker')).toBeVisible();
    // Backdrop dismisses it; the token stays in the input.
    await page.getByTestId('tag-picker-backdrop').click();
    await expect(page.getByTestId('tag-picker')).not.toBeVisible();
    await expect(input).toHaveValue('@');
  });
});
