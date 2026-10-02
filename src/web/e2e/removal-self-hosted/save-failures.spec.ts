// #3984 / #1472: actual local inference and HTTP commits; inject only a lost response.
import { test, expect, type Page, type TestInfo, type Route } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openSelfHostedFixture } from '../support/self-hosted-production';
import { savedPng } from '../removal-experimental/saved-export-oracle';

const fixture = resolve(__dirname, '../../../../test-fixtures/removal/basic/source.dng');
const model = join(
  process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models',
  'lama/native-build/lama-native-1024.onnx',
);
const connectionError = 'Cannot reach the Maple server. Check your connection and retry.';
const staleError = 'XMP changed since this removal edit opened; reload before saving';

async function dismissNotices(page: Page) {
  const notices = [
    page.locator('maple-lan-switch-banner'),
    page.locator('mui-toast').filter({ hasText: 'Editing runs on a reduced-performance path' }),
  ];
  for (const notice of notices) {
    const dismiss = notice.getByRole('button', { name: 'Dismiss', exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
  }
}

async function sidecarState(page: Page, xml: string) {
  return page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw Error('Malformed source XMP');
    const description = doc.getElementsByTagNameNS(
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      'Description',
    )[0];
    const field = (namespace: string, name: string) => description.getAttributeNS(namespace, name);
    return {
      exposure: field('http://ns.adobe.com/camera-raw-settings/1.0/', 'Exposure2012'),
      records: field('http://ns.justmaple.app/photo/1.0/', 'InpaintRemovals'),
      keep: field('urn:removal-fixture', 'Keep'),
      remote: field('urn:removal-fixture', 'Remote'),
      history: Array.from(doc.getElementsByTagNameNS('urn:removal-fixture', 'History')).map(
        (node) => new XMLSerializer().serializeToString(node),
      ),
    };
  }, xml);
}

async function review(page: Page, info: TestInfo) {
  const runtime = JSON.parse(
    await readFile(
      resolve(__dirname, '../../test-results/removal-self-hosted-runtime.json'),
      'utf8',
    ),
  ) as { root: string };
  const root = await mkdtemp(join(runtime.root, 'save-failure-'));
  await copyFile(fixture, join(root, 'photo.dng'));
  await copyFile(fixture.replace('source.dng', 'prior.xmp'), join(root, 'photo.xmp'));
  await openSelfHostedFixture(
    page,
    root,
    `Removal save failure ${info.project.name} ${info.title}`,
  );
  await page.getByRole('button', { name: 'photo.dng', exact: true }).click();
  await dismissNotices(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const gpu = page.locator('canvas[data-gpu-live]');
  if (info.project.name === 'server-removal-webgpu') await expect(gpu).toBeVisible();
  else {
    await expect(gpu).toHaveCount(0);
    await dismissNotices(page);
  }
  await page
    .getByRole('navigation', { name: 'Editor tools' })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  const panel = page.getByTestId('removal-panel');
  await panel.getByText('Local AI models', { exact: true }).click();
  await expect(panel.getByLabel('Import local removal models')).toBeEnabled();
  await panel.getByLabel('Import local removal models').setInputFiles(model);
  await expect(
    panel.getByText('lama-native-1024.onnx · Installed', { exact: false }),
  ).toBeVisible();
  const radius = panel.getByRole('slider', { name: 'Brush size', exact: true });
  await expect(radius).toBeEnabled();
  await radius.press('ArrowRight');
  const overlay = page.getByRole('img', { name: /Paint to select objects/ });
  await expect(overlay).toHaveAttribute('aria-disabled', 'false');
  const rect = await overlay.boundingBox();
  if (!rect) throw Error('No RAW selection footprint');
  await page.mouse.click(rect.x + rect.width / 2 - 1.5, rect.y + rect.height / 2 - 0.5);
  await expect(panel.getByRole('button', { name: 'Undo selection stroke' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(readdir(join(root, '.maple/inpaint'))).rejects.toThrow();
  return { root, panel };
}

function changeExposure(xml: string) {
  const tagged = xml.replace('rdf:Description', 'rdf:Description foreign:Remote="preserved"');
  return tagged.includes('crs:Exposure2012=')
    ? tagged.replace(/crs:Exposure2012="[^"]*"/, 'crs:Exposure2012="1.25"')
    : tagged.replace(
        'rdf:Description',
        'rdf:Description crs:Exposure2012="1.25" ' +
          (tagged.includes('xmlns:crs=')
            ? ''
            : 'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" '),
      );
}

/** The real server validates/publishes first. Only its HTTP acknowledgement
 * is dropped; no success body, asset, sidecar or model response is fabricated. */
async function dropCommitResponse(page: Page) {
  let resolveCommit!: (xml: string) => void;
  let rejectCommit!: (error: unknown) => void;
  const committed = new Promise<string>((resolveSaved, rejectSaved) => {
    resolveCommit = resolveSaved;
    rejectCommit = rejectSaved;
  });
  const pattern = /\/api\/removal\/xmp(?:\?|$)/;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    try {
      const actual = await route.fetch();
      expect(actual.ok(), await actual.text()).toBe(true);
      const { xml } = (await actual.json()) as { xml: string };
      await route.abort('failed');
      await page.unroute(pattern, handler);
      resolveCommit(xml);
    } catch (error) {
      rejectCommit(error);
      throw error;
    }
  };
  await page.route(pattern, handler);
  return { committed };
}

async function exportConfirmed(page: Page, root: string, info: TestInfo) {
  await page.getByTestId('editor-shell-export').click();
  const dialog = page.getByRole('dialog', { name: 'Export image', exact: true });
  await dialog.getByRole('radio', { name: 'PNG', exact: true }).click();
  const downloading = page.waitForEvent('download');
  const refreshing = page.waitForResponse(
    (r) => /\/api\/(?:removal\/)?xmp(?:\?|$)/.test(r.url()) && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  const refreshed = await refreshing;
  expect(refreshed.ok(), await refreshed.text()).toBe(true);
  const request = refreshed.request();
  const xml = request.url().includes('/api/removal/xmp')
    ? (request.postDataJSON() as { xml: string }).xml
    : request.postData();
  expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(xml);
  const output = info.outputPath('confirmed.png');
  await download.saveAs(output);
  expect(new Uint8Array(await readFile(output))).toEqual(
    await savedPng(root, info.outputPath('oracle.png')),
  );
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
}

for (const failure of ['stale-before-keep', 'lost-response', 'lost-response-later-edit'] as const) {
  test(`${failure} retains review and protects authoritative RAW edits`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { root, panel } = await review(page, info);
    const sidecar = join(root, 'photo.xmp');
    try {
      const originalXml = await readFile(sidecar, 'utf8');
      const dropped = failure === 'stale-before-keep' ? undefined : await dropCommitResponse(page);
      if (failure === 'stale-before-keep') await writeFile(sidecar, changeExposure(originalXml));
      await panel.getByRole('button', { name: 'Keep', exact: true }).click();
      const accepted = dropped ? await dropped.committed : undefined;
      await expect(
        panel.getByRole('status').filter({ hasText: dropped ? connectionError : staleError }),
      ).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeEnabled();
      await expect(panel.locator('[data-removal-id]')).toHaveCount(0);
      await expect(
        panel.getByRole('button', { name: 'Compare removal with the current photo' }),
      ).toBeEnabled();
      expect(await readFile(sidecar, 'utf8')).toBe(accepted ?? changeExposure(originalXml));
      const assets = (await readdir(join(root, '.maple/inpaint'))).sort();
      expect(assets).toHaveLength(2);
      const bytes = await Promise.all(
        assets.map((name) => readFile(join(root, '.maple/inpaint', name))),
      );
      if (failure === 'lost-response') {
        const beforeRetry = await stat(sidecar, { bigint: true });
        const response = page.waitForResponse(
          (r) => r.url().includes('/api/removal/xmp') && r.request().method() === 'POST',
        );
        await panel.getByRole('button', { name: 'Keep', exact: true }).click();
        const confirmed = await response;
        expect(confirmed.ok(), await confirmed.text()).toBe(true);
        expect(confirmed.request().postDataJSON()).toMatchObject({
          expectedRecords: '[]',
          expectedRevision: createHash('sha256').update(originalXml).digest('hex'),
          xml: accepted,
        });
        await expect(panel.getByText('Removal saved.', { exact: true })).toBeVisible();
        await expect(panel.locator('[data-removal-id]')).toHaveCount(1);
        expect(await readFile(sidecar, 'utf8')).toBe(accepted);
        expect((await stat(sidecar, { bigint: true })).mtimeNs).toBe(beforeRetry.mtimeNs);
        await page
          .getByRole('navigation', { name: 'Editor tools' })
          .getByRole('button', { name: 'Light', exact: true })
          .click();
        await dismissNotices(page);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect.poll(() => readFile(sidecar, 'utf8')).toContain('papp:InpaintRemovals="[]"');
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect.poll(() => readFile(sidecar, 'utf8')).toBe(accepted);
        await exportConfirmed(page, root, info);
      } else {
        const later =
          failure === 'stale-before-keep' ? changeExposure(originalXml) : changeExposure(accepted!);
        if (failure === 'lost-response-later-edit') await writeFile(sidecar, later);
        const response = page.waitForResponse(
          (r) => r.url().includes('/api/removal/xmp') && r.request().method() === 'POST',
        );
        await panel.getByRole('button', { name: 'Keep', exact: true }).click();
        expect((await response).status()).toBe(409);
        await expect(panel.getByRole('status').filter({ hasText: staleError })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeEnabled();
        await expect(panel.locator('[data-removal-id]')).toHaveCount(0);
        expect(await readFile(sidecar, 'utf8')).toBe(later);
        await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0);
        expect(await readFile(sidecar, 'utf8')).toBe(later);
        await page.reload();
        await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveAttribute(
          'aria-valuenow',
          '1.25',
        );
        await page
          .getByRole('navigation', { name: 'Editor tools' })
          .getByRole('button', { name: 'Remove', exact: true })
          .click();
        await expect(panel.locator('[data-removal-id]')).toHaveCount(
          failure === 'lost-response-later-edit' ? 1 : 0,
        );
        expect(await readFile(sidecar, 'utf8')).toBe(later);
        await dismissNotices(page);
        await exportConfirmed(page, root, info);
        // #943 deliberately refreshes canonical XMP on export. Preserve the
        // external edit and accepted records, rather than its original layout.
        expect(await sidecarState(page, await readFile(sidecar, 'utf8'))).toEqual(
          await sidecarState(page, later),
        );
      }
      expect((await readdir(join(root, '.maple/inpaint'))).sort()).toEqual(assets);
      expect(
        await Promise.all(assets.map((name) => readFile(join(root, '.maple/inpaint', name)))),
      ).toEqual(bytes);
      expect(await readFile(join(root, 'photo.dng'))).toEqual(await readFile(fixture));
      expect(errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
