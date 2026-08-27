import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { HOSTED_UPDATE_CONTROL_PATH } from '../support/production-update-contract';
import { test, expect } from '../support/production-test';

type HostedVersion = 'v1' | 'v2';

async function selectVersion(request: APIRequestContext, version: HostedVersion): Promise<void> {
  const response = await request.post(HOSTED_UPDATE_CONTROL_PATH, { data: { version } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function documentVersion(page: Page): Promise<string | null> {
  return page.locator('meta[name="maple-e2e-version"]').getAttribute('content');
}

async function openControlledV1(page: Page, request: APIRequestContext): Promise<void> {
  await selectVersion(request, 'v1');
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => documentVersion(page)).toBe('v1');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
}

// The update prompt renders through mui-toast/mui-toast-container (toast
// sweep, ticket #3043) rather than the deleted UpdateToastComponent's
// bespoke markup — role="status" + its message text still identify it, but
// the Install/Later buttons are now the atom's own action/close buttons
// ("Install" visible text, "Dismiss" icon-only aria-label) rather than the
// old long-form aria-labels.
function updateToast(page: Page) {
  return page.getByRole('status').filter({ hasText: 'A new version of Maple is ready.' });
}

async function detectV2(page: Page, request: APIRequestContext): Promise<void> {
  await selectVersion(request, 'v2');
  // Angular's worker checks ngsw.json after navigation requests. This reload is
  // still assigned to v1; VERSION_READY then reaches the newly booted v1 app.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => documentVersion(page)).toBe('v1');
  await expect(updateToast(page)).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
}

async function expectV2(page: Page): Promise<void> {
  await expect.poll(() => documentVersion(page)).toBe('v2');
}

async function preloadBrowseFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load('12px "JetBrains Mono"');
  });
}

async function restoreOnlineV1(context: BrowserContext, request: APIRequestContext): Promise<void> {
  await context.setOffline(false);
  await selectVersion(request, 'v1');
}

test('Hosted installs a ready service-worker version and launches v2 offline', async ({
  page,
  context,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');

  try {
    await openControlledV1(page, request);
    await detectV2(page, request);

    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await updateToast(page).getByRole('button', { name: 'Install' }).click();
    await reloaded;
    await expectV2(page);
    await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectV2(page);
    await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
  } finally {
    await restoreOnlineV1(context, request);
  }
});

test('Hosted installs a dismissed update on the next Angular route change', async ({
  page,
  context,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');

  try {
    await openControlledV1(page, request);
    await detectV2(page, request);
    await preloadBrowseFonts(page);
    await updateToast(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(updateToast(page)).toHaveCount(0);

    const navigated = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await page.evaluate(() => {
      history.pushState({}, '', '/browse');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await navigated;
    await expect(page).toHaveURL(/\/browse$/);
    await expectV2(page);
    await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
  } finally {
    await restoreOnlineV1(context, request);
  }
});
