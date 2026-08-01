import type { Page } from '@playwright/test';
import { HOSTED_ICONS } from '../../scripts/hosted-artifact-contract';
import { test, expect } from '../support/production-test';

interface NgswManifest {
  readonly assetGroups: readonly {
    readonly name: string;
    readonly urls?: readonly string[];
    readonly patterns?: readonly string[];
  }[];
  readonly dataGroups?: readonly unknown[];
}

interface AssetResult {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string | null;
  readonly byteLength: number;
  readonly head: readonly number[];
}

const ASSETS = [
  {
    path: '/assets/fonts/Lato-Regular.woff2',
    contentType: 'font/woff2',
    magic: [0x77, 0x4f, 0x46, 0x32],
  },
  {
    path: HOSTED_ICONS[0],
    contentType: 'image/png',
    magic: [0x89, 0x50, 0x4e, 0x47],
  },
  {
    path: '/raw_wasm_bg.wasm',
    contentType: 'application/wasm',
    magic: [0x00, 0x61, 0x73, 0x6d],
  },
  { path: '/pkg/raw_wasm.js', contentType: 'application/javascript' },
  { path: '/pkg/workerHelpers.worker.js', contentType: 'application/javascript' },
] as const;

async function fetchAssets(
  page: Page,
  paths: readonly string[],
): Promise<Record<string, AssetResult>> {
  return page.evaluate(async (requested) => {
    const results = await Promise.all(
      requested.map(async (path) => {
        const response = await fetch(path);
        const value = new Uint8Array(await response.arrayBuffer());
        return [
          path,
          {
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get('content-type'),
            byteLength: value.byteLength,
            head: Array.from(value.slice(0, 4)),
          },
        ] as const;
      }),
    );
    return Object.fromEntries(results);
  }, paths);
}

async function cacheContents(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const keys = await caches.keys();
    return Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => [
          key,
          (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname),
        ]),
      ),
    );
  });
}

function assertAssets(results: Readonly<Record<string, AssetResult>>): void {
  for (const expected of ASSETS) {
    const result = results[expected.path];
    expect(result, `${expected.path} must return a response`).toBeDefined();
    expect(result.ok, `${expected.path} must succeed`).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe(expected.contentType);
    expect(result.byteLength).toBeGreaterThan(0);
    if ('magic' in expected) expect(result.head).toEqual(expected.magic);
  }
}

test('Hosted service worker controls, caches, and reloads the welcome offline', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');

  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
    .toBe(`${testInfo.project.use.baseURL}/ngsw-worker.js`);

  const registrations = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
      scope: registration.scope,
      state: registration.active?.state,
    })),
  );
  expect(registrations).toEqual([
    { scope: `${testInfo.project.use.baseURL}/`, state: 'activated' },
  ]);

  const ngsw = await page.evaluate(async () => (await fetch('/ngsw.json')).json() as NgswManifest);
  expect(ngsw.dataGroups ?? []).toEqual([]);
  const cacheResources = ngsw.assetGroups.flatMap((group) => [
    ...(group.urls ?? []),
    ...(group.patterns ?? []),
  ]);
  expect(
    cacheResources.filter((resource) => resource.includes('/api') || resource.includes('\\/api')),
  ).toEqual([]);

  const apiProbePage = await context.newPage();
  await apiProbePage.goto('/');
  const apiFetchResponse = apiProbePage.waitForResponse((response) =>
    response.url().includes('/api/service-worker-fetch-probe'),
  );
  await apiProbePage.evaluate(async () => {
    await (await fetch('/api/service-worker-fetch-probe')).text();
  });
  expect((await apiFetchResponse).status()).toBe(200);

  const apiNavigation = await apiProbePage.goto('/api/service-worker-navigation-probe');
  expect(apiNavigation?.status()).toBe(200);
  await apiProbePage.goto('/');

  const rayonHelper = ngsw.assetGroups
    .find(({ name }) => name === 'raw-wasm')
    ?.urls?.find((url) => url.endsWith('/workerHelpers.js'));
  expect(rayonHelper).toBeDefined();
  const paths = [...ASSETS.map(({ path }) => path), rayonHelper!];
  assertAssets(
    await fetchAssets(
      page,
      ASSETS.map(({ path }) => path),
    ),
  );
  const helperResult = (await fetchAssets(page, [rayonHelper!]))[rayonHelper!];
  expect(helperResult).toMatchObject({ ok: true, status: 200, byteLength: expect.any(Number) });
  expect(helperResult.byteLength).toBeGreaterThan(0);

  const onlineCaches = await cacheContents(page);
  const cachedPaths = new Set(Object.values(onlineCaches).flat());
  for (const path of paths) expect(cachedPaths.has(path), `${path} must be cached`).toBe(true);
  expect([...cachedPaths].filter((path) => path.startsWith('/api/'))).toEqual([]);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
  assertAssets(
    await fetchAssets(
      page,
      ASSETS.map(({ path }) => path),
    ),
  );
  const offlineHelper = (await fetchAssets(page, [rayonHelper!]))[rayonHelper!];
  expect(offlineHelper).toMatchObject({ ok: true, status: 200 });
  expect(offlineHelper.byteLength).toBeGreaterThan(0);

  const offlineApiStatus = await apiProbePage.evaluate(
    async () => (await fetch('/api/service-worker-fetch-probe')).status,
  );
  expect(offlineApiStatus, 'Hosted must not serve an API fetch from its SPA cache').toBe(504);
  const offlineNavigationResponse = apiProbePage.waitForResponse((response) =>
    response.url().includes('/api/service-worker-navigation-probe'),
  );
  const apiNavigationFailed = await apiProbePage
    .goto('/api/service-worker-navigation-probe')
    .then(() => false)
    .catch(() => true);
  expect(apiNavigationFailed, 'Hosted must not serve an API navigation from its SPA cache').toBe(
    true,
  );
  expect((await offlineNavigationResponse).status()).toBe(504);
  await expect(apiProbePage.getByRole('button', { name: /open a photo/i })).toHaveCount(0);
  await apiProbePage.close();
  await context.setOffline(false);
});
