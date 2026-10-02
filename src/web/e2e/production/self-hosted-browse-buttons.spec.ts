import { expect, test, type Route } from '@playwright/test';

// This gate exercises the built UI and its HTTP contract. The existing API
// integration tests cover filesystem mutations; this test changes no files.
test.use({ serviceWorkers: 'block' });

const ACTIONS = ['Edit metadata', 'Merge to panorama', 'Batch rename', 'Move to', 'Move to Trash'];

const RESPONSES = new Map<string, unknown>([
  ['/api/auth/refresh', { access_token: 'browse-button-contract-token' }],
  ['/api/auth/me', { user: { id: 'button-owner', email: 'owner@example.com', role: 'owner' } }],
  [
    '/api/folders',
    [
      {
        id: 'button-library',
        slug: 'buttons',
        path: '/photos',
        label: 'Button Library',
        file_count: 2,
      },
    ],
  ],
  ['/api/fs/list-dir', { path: '/', parent: null, entries: [] }],
  [
    '/api/metadata/snapshots',
    {
      snapshots: ['one.dng', 'two.dng'].map((name) => ({
        address: `buttons:${name}`,
        metadata: {},
      })),
    },
  ],
  ['/api/assets/by-address', { id: '111111111111111111111111' }],
]);

async function respond(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path.startsWith('/api/folder/')) {
    await route.fulfill({
      json: {
        address: 'buttons:',
        parent: null,
        folders: [],
        images: ['one.dng', 'two.dng'].map((name) => ({
          name,
          address: `buttons:${name}`,
          mapleId: name,
          indexed: false,
        })),
      },
    });
  } else if (path.startsWith('/api/thumb/') || path.startsWith('/api/preview/')) {
    await route.fulfill({ status: 204 });
  } else if (
    path === '/api/assets/111111111111111111111111' &&
    route.request().method() === 'DELETE'
  ) {
    expect(url.searchParams.get('intent')).toBe('trash');
    await route.fulfill({ status: 204 });
  } else {
    await route.fulfill({ json: RESPONSES.get(path) ?? {} });
  }
}

for (const width of [1440, 768, 390]) {
  test(`Self Hosted Browse shared buttons at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chrome-self-hosted');
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(`${route.request().method()} ${path}`);
      await respond(route);
    });
    await page.goto('/browse');
    await expect(page.getByRole('button', { name: 'one.dng', exact: true })).toBeVisible();

    if (width >= 768) {
      const add = page.getByRole('button', { name: 'Add folder', exact: true });
      await expect(add).toHaveAttribute('title', 'Add a folder to your library');
      await add.focus();
      await add.press('Enter');
      await expect(page.getByRole('heading', { name: 'Pick a library folder' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }

    const openMenu = async () => {
      const more = page.getByRole('button', { name: 'More actions' });
      if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') {
        await more.click();
      }
    };
    await openMenu();
    for (const name of ACTIONS) {
      const action = page.getByRole('button', { name, exact: true });
      await expect(action).toBeDisabled();
    }
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'one.dng', exact: true }).click();
    await page.getByRole('button', { name: 'two.dng', exact: true }).click();
    await openMenu();

    for (const name of ACTIONS) {
      const action = page.getByRole('button', { name, exact: true });
      await expect(action).toBeEnabled();
      await expect(action).toContainText('(2)');
      const bounds = await action.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`browse-buttons-${width}.png`) });
    const metadata = page.getByRole('button', { name: 'Edit metadata', exact: true });
    await metadata.focus();
    await metadata.press('Enter');
    await expect.poll(() => requests.includes('POST /api/metadata/snapshots')).toBe(true);
    const dialog = page.getByRole('dialog', { name: 'Edit metadata', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/browse(?:\/|$)/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await openMenu();
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await expect(page.getByRole('button', { name: 'one.dng', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await openMenu();
    await expect(page.getByRole('status')).toContainText('Sent 2 item(s) to Trash.');
    await page.screenshot({ path: testInfo.outputPath(`browse-trash-result-${width}.png`) });
    const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
    await dismiss.focus();
    await dismiss.press('Enter');
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
    expect(
      requests.filter((request) => request === 'DELETE /api/assets/111111111111111111111111'),
    ).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}
