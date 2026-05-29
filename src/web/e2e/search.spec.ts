// Search — responsive-program S7 (#622) e2e.
//
// Verifies the new `<app-search>` renders on `/search`, focuses with
// `?autoFocus=1`, and persists recents across navigations. The Hosted
// (maple-syrup) backend doesn't serve a real search index, so we don't
// assert on response data — just on UI scaffold, debounce, and recents
// behaviour.

import { expect, test } from '@playwright/test';

test.describe('Search — phone tab content', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Clean slate so recents assertions are deterministic.
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('cm.search.recent'));
  });

  test('renders search root and scope chips on /search', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByTestId('search-root')).toBeVisible();
    await expect(page.getByTestId('search-scope-all')).toBeVisible();
    await expect(page.getByTestId('search-scope-photos')).toBeVisible();
    await expect(page.getByTestId('search-scope-places')).toBeVisible();
    await expect(page.getByTestId('search-scope-people')).toBeVisible();
    await expect(page.getByTestId('search-scope-albums')).toBeVisible();
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

  test('scope chip changes update aria-selected', async ({ page }) => {
    await page.goto('/search');
    const all = page.getByTestId('search-scope-all');
    const photos = page.getByTestId('search-scope-photos');
    await expect(all).toHaveAttribute('aria-selected', 'true');
    await photos.click();
    await expect(photos).toHaveAttribute('aria-selected', 'true');
    await expect(all).toHaveAttribute('aria-selected', 'false');
  });
});
