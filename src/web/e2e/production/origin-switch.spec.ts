import { copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { APIResponse, Locator, Page } from '@playwright/test';
import { test, expect } from '../support/production-test';
import {
  readProductionFixtureManifest,
  verifyStagedRawHashes,
} from '../support/production-fixtures';

interface PixelEvidence {
  readonly width: number;
  readonly height: number;
  readonly opaquePixels: number;
  readonly quantizedColors: number;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function waitForDevLogin(page: Page, origin: string): Promise<APIResponse> {
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await page.request.post(`${origin}/api/auth/dev-login`, { data: {} });
      if (response.ok()) return response;
      attempts.push(`${response.status()} ${(await response.text()).slice(0, 500)}`);
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error));
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`dev-login did not become ready at ${origin}:\n${attempts.join('\n')}`);
}

async function renderedPixels(canvas: Locator): Promise<PixelEvidence> {
  return canvas.evaluateAll((sources: HTMLCanvasElement[]) => {
    const width = 64;
    const height = 64;
    const evidence = sources.map((source) => {
      const copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas unavailable for pixel validation');
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const colors = new Set<number>();
      let opaquePixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3]! === 0) continue;
        opaquePixels++;
        colors.add(
          ((pixels[offset]! >> 4) << 8) |
            ((pixels[offset + 1]! >> 4) << 4) |
            (pixels[offset + 2]! >> 4),
        );
      }
      return { width, height, opaquePixels, quantizedColors: colors.size };
    });
    return evidence.reduce(
      (best, candidate) => (candidate.quantizedColors > best.quantizedColors ? candidate : best),
      { width, height, opaquePixels: 0, quantizedColors: 0 },
    );
  });
}

test('Self Hosted preserves the exact editor context through a LAN-origin handoff', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-self-hosted');

  const port = new URL(testInfo.project.use.baseURL!).port;
  const publicOrigin = `http://localhost:${port}`;
  const localOrigin = `http://127.0.0.1:${port}`;
  const manifest = await readProductionFixtureManifest();
  const libraryRoot = join(manifest.root, 'photos');
  const rawFolder = join(libraryRoot, 'raws');
  const rawPath = join(rawFolder, 'test_0008.RAF');
  await mkdir(rawFolder, { recursive: true });
  await copyFile(join(manifest.writableFolder, 'test_0008.RAF'), rawPath);
  await copyFile(join(manifest.populatedFolder, 'test_0017.xmp'), join(rawFolder, 'test_0008.xmp'));
  const rawHashBefore = await sha256(rawPath);

  const login = await waitForDevLogin(page, publicOrigin);
  const { access_token: accessToken } = (await login.json()) as { access_token: string };
  const authorization = { Authorization: `Bearer ${accessToken}` };
  const registration = await page.request.post(`${publicOrigin}/api/folders`, {
    headers: authorization,
    data: { path: libraryRoot, label: 'photos' },
  });
  expect(registration.status()).toBe(201);
  expect(await registration.json()).toMatchObject({ slug: 'photos' });
  const networkConfig = await page.request.put(`${publicOrigin}/api/network/config`, {
    headers: authorization,
    data: {
      enabled: true,
      local_ip_override: '127.0.0.1',
      local_port_override: Number(port),
    },
  });
  expect(networkConfig.ok(), await networkConfig.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${publicOrigin}/api/assets/by-address`, {
          headers: authorization,
          params: { address: 'photos:raws/test_0008.RAF' },
        });
        return response.status();
      },
      { timeout: 60_000 },
    )
    .toBe(200);

  const expectedPath = '/edit/photos/raws/test_0008.RAF';
  await page.goto(`${publicOrigin}${expectedPath}`);
  await expect(page).toHaveURL(`${publicOrigin}${expectedPath}`);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('test_0008.RAF', { exact: true }).first()).toBeVisible();
  const canvas = page.locator('editor-image-canvas canvas');
  await expect
    .poll(async () => (await renderedPixels(canvas)).quantizedColors, { timeout: 90_000 })
    .toBeGreaterThan(16);
  const before = await renderedPixels(canvas);

  const switchAction = page.getByRole('button', { name: 'Switch to a local connection' });
  await expect(switchAction).toBeVisible({ timeout: 30_000 });
  const handoffIssue = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url() === `${publicOrigin}/api/auth/lan-handoff`,
  );
  const handoffRedeem = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url() === `${localOrigin}/api/auth/lan-handoff/redeem`,
  );
  await switchAction.click();
  expect((await handoffIssue).ok()).toBe(true);
  expect((await handoffRedeem).ok()).toBe(true);

  await expect(page).toHaveURL(`${localOrigin}${expectedPath}`, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.has('lan_handoff')).toBe(false);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('test_0008.RAF', { exact: true }).first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(switchAction).toHaveCount(0);
  await expect
    .poll(async () => (await renderedPixels(canvas)).quantizedColors, { timeout: 90_000 })
    .toBeGreaterThan(16);
  const after = await renderedPixels(canvas);

  expect(await sha256(rawPath), 'the origin switch must never mutate the RAW').toBe(rawHashBefore);
  await verifyStagedRawHashes(manifest);
  await testInfo.attach('origin-switch-evidence.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          from: `${publicOrigin}${expectedPath}`,
          to: page.url(),
          handoffQueryScrubbed: !new URL(page.url()).searchParams.has('lan_handoff'),
          before,
          after,
          rawPath,
          rawSha256: rawHashBefore,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
});
