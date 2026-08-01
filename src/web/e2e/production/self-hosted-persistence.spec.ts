import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { APIResponse, Request } from '@playwright/test';
import { test, expect } from '../support/production-test';
import {
  readProductionFixtureManifest,
  verifyStagedRawHashes,
} from '../support/production-fixtures';

test('Self Hosted persists adjustments and culling in a real sibling XMP', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-self-hosted');
  const pendingHistogramRequests = new Set<Request>();
  page.on('request', (request) => {
    if (request.url().includes('/histogram')) pendingHistogramRequests.add(request);
  });
  const settleHistogram = (request: Request): void => {
    pendingHistogramRequests.delete(request);
  };
  page.on('requestfinished', settleHistogram);
  page.on('requestfailed', settleHistogram);

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
  const workflowHistogramRequests: Request[] = [];
  const trackWorkflowHistogram = (request: Request): void => {
    if (request.url().includes('/histogram')) workflowHistogramRequests.push(request);
  };
  page.on('request', trackWorkflowHistogram);
  const histogramReady = page.waitForResponse(
    (response) => response.url().includes('/histogram') && response.ok(),
  );
  await asset.click();
  await histogramReady;
  await expect.poll(() => pendingHistogramRequests.size).toBe(0);
  expect(workflowHistogramRequests, 'Preview must request one server histogram').toHaveLength(1);
  const previewHistogramRequestCount = workflowHistogramRequests.length;
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

  const authenticatedReload = page.waitForResponse(
    (response) => response.url().includes('/api/xmp?') && response.ok(),
  );
  await page.reload();
  await authenticatedReload;
  await expect(exposure).toBeVisible({ timeout: 60_000 });
  await expect(exposure).toHaveAttribute('aria-valuenow', editedExposure!);
  await page.getByRole('button', { name: 'Info', exact: true }).click();
  await expect(page.getByTestId('info-enrichment')).toBeVisible();
  await expect(page.getByTestId('info-histogram').locator('svg.live')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pick', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('radio', { name: '5 stars' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
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
  expect(
    workflowHistogramRequests,
    'Editor must derive its histogram from live pixels without another server request',
  ).toHaveLength(previewHistogramRequestCount);
  page.off('request', trackWorkflowHistogram);
  await verifyStagedRawHashes(manifest);
});
