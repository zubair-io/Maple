import { expect, test } from '../support/production-test';

test('production Browse exposes only the app-provided capability surface', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'chrome-self-hosted') {
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/refresh') {
        await route.fulfill({ json: { access_token: 'browser-contract-token' } });
        return;
      }
      if (path === '/api/auth/me') {
        await route.fulfill({
          json: { user: { id: 'browser-contract', email: 'test@maple.local', role: 'owner' } },
        });
        return;
      }
      if (path === '/api/folders') {
        await route.fulfill({ json: [] });
        return;
      }
      await route.fulfill({ json: {} });
    });
  }

  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.goto('/browse');
  await page.waitForLoadState('networkidle');

  const viewMode = page.getByRole('group', { name: 'View mode' });
  if (testInfo.project.name === 'chrome-hosted') {
    await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add folder' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Timeline' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import folder/ })).toHaveCount(0);
    await expect(viewMode).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit metadata' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Merge to panorama' })).toHaveCount(0);
    expect(apiRequests).toEqual([]);
    return;
  }

  await expect(viewMode).toBeVisible();
  const sidebar = page.getByTestId('source-sidebar');
  await expect(
    sidebar.locator('.section-bar').getByRole('button', { name: 'Add folder' }),
  ).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Timeline', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit metadata' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge to panorama' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open settings' })).toBeVisible();
});
