import { expect, test } from '@playwright/test';

// Playwright routes cannot intercept requests issued by Angular's service worker.
// This test supplies the API contract; service-worker tests use the real server.
test.use({ serviceWorkers: 'block' });

const ME = '111111111111111111111111';
const MEMBER = '222222222222222222222222';

for (const width of [1440, 768, 390, 320]) {
  test(`Timeline owner filtering, retry and clear at ${width}px`, async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chrome-self-hosted',
      'Server Timeline is Self Hosted only.',
    );
    await page.setViewportSize({ width, height: 900 });
    const searches: URLSearchParams[] = [];
    const facets: URLSearchParams[] = [];
    const pageErrors: string[] = [];
    let failFacets = false;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Exercise the production client against the ownership wire contract.
    // The real SQLite projection/filter contract is covered by API integration tests.
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/refresh') {
        await route.fulfill({ json: { access_token: 'timeline-contract-token' } });
      } else if (url.pathname === '/api/auth/me') {
        await route.fulfill({
          json: {
            user: {
              id: ME,
              email: 'me@example.com',
              role: 'member',
              file_access: false,
            },
          },
        });
      } else if (url.pathname === '/api/folders') {
        await route.fulfill({ json: [] });
      } else if (url.pathname === '/api/search/facets') {
        facets.push(url.searchParams);
        await route.fulfill(
          failFacets
            ? { status: 503, json: { error: 'Unavailable' } }
            : {
                json: {
                  total: 0,
                  owners: [
                    { id: ME, email: 'me@example.com', count: 4 },
                    { id: MEMBER, email: 'studio@example.com', count: 3 },
                  ],
                },
              },
        );
      } else if (url.pathname === '/api/search') {
        searches.push(url.searchParams);
        await route.fulfill({
          json: {
            total: 0,
            page: 0,
            limit: 200,
            results: [],
            cursorPaging: true,
            nextCursor: null,
          },
        });
      } else {
        await route.fulfill({ json: {} });
      }
    });
    await page.goto('/browse');
    const picker = page.getByRole('combobox', { name: 'Asset owner' });
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveCount(3);
    await picker.evaluate((element) => {
      document.addEventListener('keydown', (event) => {
        if (event.target === element && event.defaultPrevented) {
          element.setAttribute('data-intercepted-key', event.key);
        }
      });
    });
    await picker.focus();
    await picker.press('ArrowDown');
    await picker.press('Escape');
    await expect(picker).not.toHaveAttribute('data-intercepted-key');
    // Chrome on macOS opens an OS-native option popup; headless key events do
    // not commit even on a bare HTML select. selectOption dispatches the native
    // input/change events, while the assertion above guards shell interception.
    await picker.selectOption(ME);
    await expect(picker).toHaveValue(ME);
    await expect.poll(() => searches.at(-1)?.get('ownerId')).toBe(ME);
    await picker.selectOption(MEMBER);
    await expect.poll(() => searches.at(-1)?.get('ownerId')).toBe(MEMBER);
    expect(searches.at(-1)?.get('page')).toBe('0');
    expect(searches.at(-1)?.get('hasCapturedAt')).toBe('true');
    expect(searches.at(-1)?.get('libraryId')).toBeNull();
    expect(facets.every((params) => !params.has('ownerId'))).toBe(true);

    // Every filter remains reachable and contained after wrapping at phone widths.
    const row = page.locator('app-timeline-filter-row');
    const overflow = await row.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.left < -1 || bounds.right > window.innerWidth + 1) return true;
      return Array.from(element.querySelectorAll('button,input,select')).some((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      });
    });
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`timeline-owner-${width}.png`) });

    failFacets = true;
    await page.getByLabel('Captured from', { exact: true }).fill('2026-01-01');
    await expect(page.getByText('Could not load owners.', { exact: true })).toBeVisible();
    await expect(picker).toHaveValue(MEMBER);
    await expect(picker.locator('option:checked')).toHaveText('studio@example.com');
    await page.screenshot({ path: testInfo.outputPath(`timeline-owner-error-${width}.png`) });
    failFacets = false;
    await page.getByRole('button', { name: 'Retry loading owners' }).click();
    await expect(page.getByText('Could not load owners.', { exact: true })).toHaveCount(0);
    await expect(picker).toHaveValue(MEMBER);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(picker).toHaveValue('');
    await expect.poll(() => searches.at(-1)?.has('ownerId')).toBe(false);
    expect(pageErrors).toEqual([]);
  });
}
