import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { test, expect } from '../support/production-test';
import {
  readProductionFixtureManifest,
  verifyStagedRawHashes,
} from '../support/production-fixtures';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import type { APIResponse, Request } from '@playwright/test';

type CacheFormatMatcher = (bytes: Buffer) => boolean;

const asciiAt = (bytes: Buffer, offset: number, expected: string): boolean =>
  bytes.subarray(offset, offset + expected.length).toString('ascii') === expected;

const CACHE_FORMAT_MATCHERS: Readonly<Record<string, CacheFormatMatcher>> = {
  '.jpg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8,
  '.png': (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.webp': (bytes) => asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP'),
  '.avif': (bytes) =>
    bytes.length >= 12 &&
    asciiAt(bytes, 4, 'ftyp') &&
    ['avif', 'avis'].some((brand) => bytes.subarray(8).toString('ascii').includes(brand)),
};

function cacheFormatMatches(path: string, bytes: Buffer): boolean {
  return CACHE_FORMAT_MATCHERS[extname(path)]?.(bytes) ?? false;
}

test('serves a production build in installed Google Chrome', async ({ page }, testInfo) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Chrome/');

  if (testInfo.project.name === 'chrome-hosted') {
    await expect(page.getByRole('button', { name: /open a photo/i })).toBeVisible();
  } else {
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({ ok: true, product: 'maple' });
  }
});

test('uses disposable RAW copies and records immutable source hashes', async () => {
  const manifest = await readProductionFixtureManifest();
  expect(manifest.root).not.toContain('test-fixtures/raws');
  expect(manifest.sourceHashes).toHaveLength(5);
  expect(manifest.stagedRawHashes).toHaveLength(7);
  const sourceHashes = new Map(
    manifest.sourceHashes.map(({ path, sha256 }) => [basename(path).toLowerCase(), sha256]),
  );
  for (const staged of manifest.stagedRawHashes) {
    expect(staged.sha256).toBe(sourceHashes.get(basename(staged.path).toLowerCase()));
  }
  await Promise.all([
    access(`${manifest.populatedFolder}/.maple/thumbs`),
    access(`${manifest.populatedFolder}/.maple/previews`),
  ]);
  expect(await readFile(`${manifest.populatedFolder}/test_0017.xmp`, 'utf8')).toContain(
    '<x:xmpmeta',
  );
});

async function openWritableFolder(
  page: import('@playwright/test').Page,
  filename = 'test_0006.DNG',
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.getByRole('button', { name: filename, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function openWritableRawEditor(page: import('@playwright/test').Page): Promise<void> {
  await openWritableFolder(page);
  await page.getByRole('button', { name: 'test_0006.DNG', exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 60_000 });
}

test('Hosted writable folder creates its .maple cache without modifying the RAW', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  await installProductionFolderPicker(page, manifest.writableFolder);

  const coldStarted = Date.now();
  await openWritableFolder(page);
  await expect(page.getByRole('status', { name: /save/i })).toHaveCount(0);

  await expect
    .poll(
      async () =>
        readdir(join(manifest.writableFolder, '.maple', 'thumbs')).catch(() => [] as string[]),
      { timeout: 90_000 },
    )
    .toEqual(expect.arrayContaining([expect.stringMatching(/\.(?:avif|jpg)$/)]));
  const thumbNames = await readdir(join(manifest.writableFolder, '.maple', 'thumbs'));
  for (const name of thumbNames.filter((candidate) => /\.(?:avif|jpg)$/.test(candidate))) {
    const path = join(manifest.writableFolder, '.maple', 'thumbs', name);
    expect(cacheFormatMatches(path, await readFile(path)), `${name} must match its extension`).toBe(
      true,
    );
  }
  await expect
    .poll(async () =>
      readFile(join(manifest.writableFolder, '.maple', 'index.json'), 'utf8').catch(() => ''),
    )
    .toContain('test_0006.DNG');
  const coldReadyMs = Date.now() - coldStarted;

  await page.goto('/');
  const warmStarted = Date.now();
  await openWritableFolder(page);
  const warmThumb = page.getByRole('button', { name: 'test_0006.DNG', exact: true }).locator('img');
  await expect(warmThumb).toBeVisible();
  await expect
    .poll(() => warmThumb.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const warmReadyMs = Date.now() - warmStarted;
  expect(
    warmReadyMs,
    'warm folder paint must beat the measured cold cache generation',
  ).toBeLessThan(coldReadyMs);
  expect(
    warmReadyMs,
    'warm folder paint must stay inside the 5 second release ceiling',
  ).toBeLessThan(5_000);
  await testInfo.attach('hosted-folder-cold-warm-timing.json', {
    body: Buffer.from(JSON.stringify({ coldReadyMs, warmReadyMs }, null, 2)),
    contentType: 'application/json',
  });
});

test('Hosted uses an existing .maple preview before reading the RAW', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  const picker = await installProductionFolderPicker(page, manifest.populatedFolder);

  const openStarted = Date.now();
  await openWritableFolder(page, 'test_0017.dng');
  const browseReadyMs = Date.now() - openStarted;
  picker.clear();

  const previewStarted = Date.now();
  await page.getByRole('button', { name: 'test_0017.dng', exact: true }).click();
  const fullPreview = page.locator('.preview-img--full');
  await expect(fullPreview).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => fullPreview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const previewReadyMs = Date.now() - previewStarted;

  const previewRead = picker.operations.findIndex(
    ({ kind, path }) => kind === 'read' && path === '.maple/previews/test_0017.dng.avif',
  );
  const rawRead = picker.operations.findIndex(
    ({ kind, path }) => kind === 'read' && path === 'test_0017.dng',
  );
  expect(previewRead, 'the canonical cached preview must be read').toBeGreaterThanOrEqual(0);
  expect(rawRead, 'the cached preview must win before a RAW byte read').toBe(-1);
  expect(
    cacheFormatMatches(
      join(manifest.populatedFolder, '.maple', 'previews', 'test_0017.dng.avif'),
      await readFile(join(manifest.populatedFolder, '.maple', 'previews', 'test_0017.dng.avif')),
    ),
  ).toBe(true);

  await testInfo.attach('hosted-folder-cache-timing.json', {
    body: Buffer.from(JSON.stringify({ browseReadyMs, previewReadyMs }, null, 2)),
    contentType: 'application/json',
  });
});

test("Hosted records Chrome's actual preview format and reuses it without reading the RAW", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  const picker = await installProductionFolderPicker(page, manifest.writableFolder);

  await openWritableFolder(page);
  picker.clear();
  await page.getByRole('button', { name: 'test_0006.DNG', exact: true }).click();
  const fullPreview = page.locator('.preview-img--full');
  await expect(fullPreview).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => fullPreview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  const descriptorPath = join(
    manifest.writableFolder,
    '.maple',
    'previews',
    'test_0006.DNG.preview.json',
  );
  await expect
    .poll(() => readFile(descriptorPath, 'utf8').catch(() => ''), { timeout: 90_000 })
    .not.toBe('');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    version: number;
    format: 'avif' | 'jpeg' | 'webp' | 'png';
    mimeType: string;
    source: { size: number; lastModified: number };
  };
  const extensions = { avif: 'avif', jpeg: 'jpg', webp: 'webp', png: 'png' } as const;
  const mimeTypes = {
    avif: 'image/avif',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    png: 'image/png',
  } as const;
  const artifactName = `test_0006.DNG.${extensions[descriptor.format]}`;
  const artifactPath = join(manifest.writableFolder, '.maple', 'previews', artifactName);
  expect(descriptor).toMatchObject({
    version: 1,
    mimeType: mimeTypes[descriptor.format],
    source: { size: expect.any(Number), lastModified: expect.any(Number) },
  });
  expect(cacheFormatMatches(artifactPath, await readFile(artifactPath))).toBe(true);

  await page.goto('/');
  await openWritableFolder(page);
  picker.clear();
  await page.getByRole('button', { name: 'test_0006.DNG', exact: true }).click();
  await expect(page.locator('.preview-img--full')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      picker.operations.some(
        ({ kind, path }) => kind === 'read' && path === `.maple/previews/${artifactName}`,
      ),
    )
    .toBe(true);
  expect(
    picker.operations.some(({ kind, path }) => kind === 'read' && path === 'test_0006.DNG'),
    'a valid descriptor/artifact pair must win before a RAW byte read',
  ).toBe(false);
});

test('Hosted writable folder writes XMP and restores it after a reload and re-open', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();
  const picker = await installProductionFolderPicker(page, manifest.writableFolder);

  await openWritableRawEditor(page);
  await expect(page.locator('editor-filmstrip')).toBeVisible();
  const descriptorPath = join(
    manifest.writableFolder,
    '.maple',
    'previews',
    'test_0006.DNG.preview.json',
  );
  await expect
    .poll(() => readFile(descriptorPath, 'utf8').catch(() => ''), { timeout: 90_000 })
    .not.toBe('');
  const beforeEditDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    format: 'avif' | 'jpeg' | 'webp' | 'png';
    artifactLastModified: number;
  };
  const extensions = { avif: 'avif', jpeg: 'jpg', webp: 'webp', png: 'png' } as const;
  const beforeEditArtifact = join(
    manifest.writableFolder,
    '.maple',
    'previews',
    `test_0006.DNG.${extensions[beforeEditDescriptor.format]}`,
  );
  const beforeEditBytes = await readFile(beforeEditArtifact);
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  const selectedUrl = page.url();
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
  expect(page.url()).toBe(selectedUrl);
  await expect(page.getByRole('button', { name: 'test_0006.DNG', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const editedExposure = await exposure.getAttribute('aria-valuenow');
  expect(editedExposure).not.toBeNull();
  expect(editedExposure).not.toBe('0');

  const sidecar = join(manifest.writableFolder, 'test_0006.xmp');
  await expect
    .poll(async () => readFile(sidecar, 'utf8').catch(() => ''))
    .toContain(`crs:Exposure2012="${editedExposure}"`);

  await expect
    .poll(
      async () => {
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
          artifactLastModified: number;
        };
        return descriptor.artifactLastModified;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(beforeEditDescriptor.artifactLastModified);
  const developedDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    format: 'avif' | 'jpeg' | 'webp' | 'png';
  };
  const developedArtifactName = `test_0006.DNG.${extensions[developedDescriptor.format]}`;
  const developedBytes = await readFile(
    join(manifest.writableFolder, '.maple', 'previews', developedArtifactName),
  );
  expect(developedBytes.equals(beforeEditBytes), 'the post-edit preview pixels must change').toBe(
    false,
  );

  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await openWritableFolder(page);
  picker.clear();
  await page.getByRole('button', { name: 'test_0006.DNG', exact: true }).click();
  const fullPreview = page.locator('.preview-img--full');
  await expect(fullPreview).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => fullPreview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      picker.operations.some(
        ({ kind, path }) => kind === 'read' && path === `.maple/previews/${developedArtifactName}`,
      ),
    )
    .toBe(true);
  expect(
    picker.operations.some(({ kind, path }) => kind === 'read' && path === 'test_0006.DNG'),
    'the developed preview must paint before any RAW byte read',
  ).toBe(false);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  const restoredExposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(restoredExposure).toHaveAttribute('aria-valuenow', editedExposure!);

  const expectedErrorPrefix = 'XmpStoreService: write failed for test_0006.DNG:';
  testInfo.annotations.push({ type: 'expected-console-error', description: expectedErrorPrefix });
  const expectedErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith(expectedErrorPrefix)) {
      expectedErrors.push(message.text());
    }
  });

  picker.setWritePermission(false);
  await restoredExposure.focus();
  await restoredExposure.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('Edits are not saved');
  await expect.poll(() => expectedErrors).toHaveLength(1);

  picker.setWritePermission(true);
  await restoredExposure.press('ArrowRight');
  const recoveredExposure = await restoredExposure.getAttribute('aria-valuenow');
  expect(recoveredExposure).not.toBe(editedExposure);
  await expect
    .poll(async () => readFile(sidecar, 'utf8').catch(() => ''))
    .toContain(`crs:Exposure2012="${recoveredExposure}"`);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Hosted opens one RAW directly and downloads its XMP without a filmstrip', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  const manifest = await readProductionFixtureManifest();

  await page.goto('/');
  const pairedDir = join(manifest.root, 'single-file-paired-xmp');
  const pairedXmp = join(pairedDir, 'test_0006.xmp');
  await mkdir(pairedDir, { recursive: true });
  await writeFile(
    pairedXmp,
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:foreign="urn:maple:e2e:foreign"
      crs:Exposure2012="0"
      foreign:opaque="keep-me">
      <foreign:Payload foreign:version="7">opaque payload</foreign:Payload>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`,
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles([join(manifest.freshFolder, 'test_0006.DNG'), pairedXmp]);

  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('editor-filmstrip')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Single-file save' })).toContainText(
    'Paired XMP loaded',
  );

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await exposure.focus();
  await exposure.press('ArrowRight');
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0');
  const editedExposure = await exposure.getAttribute('aria-valuenow');
  expect(editedExposure).not.toBeNull();
  await expect(page.getByTestId('editor-shell-undo')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XMP' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(download.suggestedFilename()).toBe('test_0006.xmp');
  expect(downloadPath).not.toBeNull();
  const xml = await readFile(downloadPath!, 'utf8');
  expect(xml).toContain('<x:xmpmeta');
  expect(xml).toMatch(/crs:Exposure2012="(?!0(?:\.0+)?")/);
  expect(
    await page.evaluate((downloadedXml) => {
      const document = new DOMParser().parseFromString(downloadedXml, 'application/xml');
      const namespace = 'urn:maple:e2e:foreign';
      const description = document.getElementsByTagNameNS(
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'Description',
      )[0];
      const payload = document.getElementsByTagNameNS(namespace, 'Payload')[0];
      return {
        parseError: document.getElementsByTagName('parsererror').length > 0,
        opaque: description?.getAttributeNS(namespace, 'opaque'),
        payload: payload?.textContent,
        version: payload?.getAttributeNS(namespace, 'version'),
      };
    }, xml),
  ).toEqual({
    parseError: false,
    opaque: 'keep-me',
    payload: 'opaque payload',
    version: '7',
  });
  await expect(page.getByRole('status', { name: 'Single-file save' })).toContainText(
    'XMP downloaded',
  );

  await page.goto('/');
  const reimportXmp = join(manifest.freshFolder, download.suggestedFilename());
  await writeFile(reimportXmp, xml);
  await page
    .locator('input[type="file"]')
    .setInputFiles([join(manifest.freshFolder, 'test_0006.DNG'), reimportXmp]);
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('editor-filmstrip')).toHaveCount(0);
  const restoredExposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(restoredExposure).toBeVisible({ timeout: 60_000 });
  await expect(restoredExposure).toHaveAttribute('aria-valuenow', editedExposure!);
  await expect(page.getByRole('status', { name: 'Single-file save' })).toContainText(
    'Paired XMP loaded',
  );

  await page.reload();
  await expect(restoredExposure).toBeVisible({ timeout: 60_000 });
  await expect(restoredExposure).toHaveAttribute('aria-valuenow', editedExposure!);
  await restoredExposure.focus();
  await restoredExposure.press('ArrowRight');
  await expect(page.getByRole('status', { name: 'Single-file save' })).toContainText(
    'only in this browser session',
  );
});

test('Self Hosted persists adjustments and culling in a real sibling XMP', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-self-hosted');
  const manifest = await readProductionFixtureManifest();
  const sidecar = join(manifest.writableFolder, 'test_0006.xmp');
  await writeFile(
    sidecar,
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:foreign="urn:maple:e2e:foreign"
      crs:Exposure2012="0.25"
      xmp:Rating="0"
      papp:Flag="unflagged"
      foreign:opaque="keep-me">
      <foreign:Payload foreign:version="7">opaque payload</foreign:Payload>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`,
  );
  await writeFile(
    join(manifest.writableFolder, 'test_0008.xmp'),
    '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
  );

  let setupLogin: APIResponse | null = null;
  const loginAttempts: string[] = [];
  for (let attempt = 1; attempt <= 20; attempt++) {
    const response = await page.request.post('/api/auth/dev-login', { data: {} });
    const body = await response.text();
    loginAttempts.push(`attempt ${attempt}: ${response.status()} ${body.slice(0, 500)}`);
    if (response.ok()) {
      setupLogin = response;
      break;
    }
    await page.waitForTimeout(250);
  }
  expect(setupLogin, `dev-login did not become ready:\n${loginAttempts.join('\n')}`).not.toBeNull();
  const login = (await setupLogin!.json()) as { access_token: string };
  const registration = await page.request.post('/api/folders', {
    headers: { Authorization: `Bearer ${login.access_token}` },
    data: { path: manifest.writableFolder, label: 'Persistence fixture' },
  });
  expect(registration.status()).toBe(201);
  const warmThumb = await readFile(
    join(manifest.populatedFolder, '.maple', 'thumbs', '5170a2440f3250ea.avif'),
  );
  const thumbDir = join(manifest.writableFolder, '.maple', 'thumbs');
  await mkdir(thumbDir, { recursive: true });
  await Promise.all(
    ['test_0006.DNG', 'test_0008.RAF'].map((filename) =>
      writeFile(
        join(thumbDir, `${createHash('sha256').update(filename).digest('hex').slice(0, 16)}.avif`),
        warmThumb,
      ),
    ),
  );

  await page.goto('/sign-in');
  await page.getByTestId('dev-sign-in').click();
  const asset = page.getByRole('button', { name: 'test_0006.DNG', exact: true });
  await expect(asset).toBeVisible({ timeout: 60_000 });
  const histogramReady = page.waitForResponse(
    (response) => response.url().includes('/histogram') && response.ok(),
  );
  await asset.click();
  await histogramReady;
  const dismissLanBanner = page.getByRole('button', { name: 'Dismiss', exact: true });
  if (await dismissLanBanner.isVisible()) await dismissLanBanner.click();
  await page.getByLabel('Edit', { exact: true }).click();
  const exposure = page.getByRole('slider', { name: 'Exposure' });
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await expect(exposure).toHaveAttribute('aria-valuenow', '0.25');

  await exposure.focus();
  const firstWrite = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/xmp?'),
  );
  await exposure.press('ArrowRight');
  const firstWriteResponse = await firstWrite;
  expect(firstWriteResponse.ok(), await firstWriteResponse.text()).toBe(true);
  const editedExposure = await exposure.getAttribute('aria-valuenow');
  expect(editedExposure).not.toBeNull();
  await exposure.blur();
  await page.keyboard.press('p');
  await page.keyboard.press('5');
  await expect
    .poll(async () => {
      const xml = await readFile(sidecar, 'utf8');
      return (
        xml.includes(`crs:Exposure2012="${editedExposure}"`) &&
        xml.includes('xmp:Rating="5"') &&
        xml.includes('papp:Flag="pick"')
      );
    })
    .toBe(true);
  let savedXml = await readFile(sidecar, 'utf8');
  expect(savedXml).toContain('xmp:Rating="5"');
  expect(savedXml).toContain('papp:Flag="pick"');
  expect(
    await page.evaluate((xml) => {
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      const namespace = 'urn:maple:e2e:foreign';
      const description = document.getElementsByTagNameNS(
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'Description',
      )[0];
      const payload = document.getElementsByTagNameNS(namespace, 'Payload')[0];
      return {
        parseError: document.getElementsByTagName('parsererror').length > 0,
        opaque: description?.getAttributeNS(namespace, 'opaque'),
        payload: payload?.textContent,
        version: payload?.getAttributeNS(namespace, 'version'),
      };
    }, savedXml),
  ).toEqual({ parseError: false, opaque: 'keep-me', payload: 'opaque payload', version: '7' });

  const pendingHistogramRequests = new Set<Request>();
  page.on('request', (request) => {
    if (request.url().includes('/histogram')) pendingHistogramRequests.add(request);
  });
  const settleHistogram = (request: Request): void => {
    pendingHistogramRequests.delete(request);
  };
  page.on('requestfinished', settleHistogram);
  page.on('requestfailed', settleHistogram);

  const authenticatedReload = page.waitForResponse(
    (response) => response.url().includes('/api/xmp?') && response.ok(),
  );
  await page.reload();
  await authenticatedReload;
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await expect(exposure).toHaveAttribute('aria-valuenow', editedExposure!);
  const restoredHistogram = page.waitForResponse((response) =>
    response.url().includes('/histogram'),
  );
  await page.getByRole('button', { name: 'Info', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pick', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('radio', { name: '5 stars' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect((await restoredHistogram).ok()).toBe(true);
  await expect.poll(() => pendingHistogramRequests.size).toBe(0);
  await page.getByRole('button', { name: 'Info', exact: true }).click();
  savedXml = await readFile(sidecar, 'utf8');

  testInfo.annotations.push({
    type: 'expected-console-error',
    description: 'putXmp failed for asset ',
  });
  testInfo.annotations.push({
    type: 'expected-console-error',
    description: 'Failed to load resource: the server responded with a status of 500',
  });
  testInfo.annotations.push({
    type: 'expected-response-error',
    description: `500 POST ${new URL(testInfo.project.use.baseURL!).origin}/api/xmp`,
  });
  await chmod(manifest.writableFolder, 0o555);
  try {
    await exposure.focus();
    await exposure.press('ArrowRight');
    await expect(page.getByRole('alert')).toContainText('Edits are not saved');
    await page.waitForTimeout(500);
    expect(await readFile(sidecar, 'utf8')).toBe(savedXml);
  } finally {
    await chmod(manifest.writableFolder, 0o755);
  }

  const recoveryWrite = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/xmp?'),
  );
  await exposure.press('ArrowRight');
  const recoveredExposure = await exposure.getAttribute('aria-valuenow');
  const recoveryResponse = await recoveryWrite;
  expect(recoveryResponse.ok()).toBe(true);
  expect(recoveryResponse.request().postData()).toContain(
    `crs:Exposure2012="${recoveredExposure}"`,
  );
  expect(recoveredExposure).not.toBe(editedExposure);
  await expect
    .poll(async () => readFile(sidecar, 'utf8'))
    .toContain(`crs:Exposure2012="${recoveredExposure}"`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const recoveredXml = await readFile(sidecar, 'utf8');
  expect(recoveredXml).toContain('xmp:Rating="5"');
  expect(recoveredXml).toContain('papp:Flag="pick"');
  expect(
    await page.evaluate((xml) => {
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      const namespace = 'urn:maple:e2e:foreign';
      const description = document.getElementsByTagNameNS(
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'Description',
      )[0];
      const payload = document.getElementsByTagNameNS(namespace, 'Payload')[0];
      return {
        opaque: description?.getAttributeNS(namespace, 'opaque'),
        payload: payload?.textContent,
        version: payload?.getAttributeNS(namespace, 'version'),
      };
    }, recoveredXml),
  ).toEqual({ opaque: 'keep-me', payload: 'opaque payload', version: '7' });
  await verifyStagedRawHashes(manifest);
});
