import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/production-test';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import {
  readProductionFixtureManifest,
  verifyOriginalRawHashes,
  verifyStagedRawHashes,
} from '../support/production-fixtures';

const SOURCE = 'test_0006.DNG';
const TARGET = 'test_0008.RAF';

function hostedOnly(projectName: string): void {
  test.skip(projectName !== 'chrome-hosted');
}

function seedXmp(exposure: number): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple production browser audit">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:papp="http://ns.justmaple.app/photo/1.0/"
    crs:Version="11.0"
    crs:Exposure2012="${exposure}" />
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

async function expectAssets(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: SOURCE, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: TARGET, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

async function openBrowseFolder(page: Page): Promise<void> {
  await page.goto('/browse');
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expectAssets(page);
}

async function waitForXmpWrite(page: Page, path: string, value: RegExp): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(50);
        try {
          return await readFile(path, 'utf8');
        } catch {
          return '';
        }
      },
      { timeout: 15_000 },
    )
    .toMatch(value);
}

async function gridNames(page: Page): Promise<string[]> {
  return page
    .locator('app-asset-grid maple-asset-thumb > button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
}

async function expectPreviewPixels(image: Locator): Promise<void> {
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
}

test('Hosted Browse and Preview visible actions work in installed Chrome', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo.project.name);
  test.setTimeout(300_000);
  const manifest = await readProductionFixtureManifest();
  const sourceXmp = join(manifest.writableFolder, 'test_0006.xmp');
  const targetXmp = join(manifest.writableFolder, 'test_0008.xmp');
  await Promise.all([writeFile(sourceXmp, seedXmp(1.25)), writeFile(targetXmp, seedXmp(-0.5))]);
  const picker = await installProductionFolderPicker(page, manifest.writableFolder);

  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await openBrowseFolder(page);

  // Hosted owns local browser files. Server registration/import controls are
  // absent; the writable File System Access action and one-off RAW action stay.
  await expect(page.getByRole('button', { name: 'Add folder' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Import folder/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import RAW files' })).toBeVisible();
  expect(apiRequests).toEqual([]);

  const sidebar = page.getByTestId('source-sidebar');
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '0px');
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar).not.toHaveCSS('width', '0px');

  const size = page.getByRole('slider', { name: 'Thumbnail size' });
  await size.fill('180');
  await expect(size).toHaveValue('180');
  await expect(size).toHaveAttribute('aria-valuetext', '180 pixels');

  await page.getByRole('button', { name: 'Sort: Date' }).click();
  await expect(page.getByRole('button', { name: 'Sort: Name' })).toBeVisible();
  expect(await gridNames(page)).toEqual([SOURCE, TARGET]);

  // Select mode is the non-keyboard multi-select path. Copy, selective Paste,
  // and Sync run against real restored sidecars in the disposable folder.
  const select = page.getByRole('button', { name: 'Select', exact: true });
  await select.click();
  await page.getByRole('button', { name: TARGET, exact: true }).click();
  await page.getByRole('button', { name: SOURCE, exact: true }).click();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  const copy = page.getByRole('button', { name: 'Copy settings' });
  await expect(copy).toBeEnabled();
  await copy.click();

  const paste = page.getByRole('button', { name: 'Paste settings' });
  await expect(paste).toBeEnabled();
  await paste.click();
  const dialog = page.getByRole('dialog', { name: 'Paste settings' });
  await expect(dialog).toContainText(`Paste from ${SOURCE} onto 2 photos`);
  await dialog.getByRole('button', { name: 'Paste (2)' }).click();
  await waitForXmpWrite(page, targetXmp, /crs:Exposure2012="1\.25"/);

  picker.clear();
  const sync = page.getByRole('button', { name: 'Sync settings' });
  await expect(sync).toBeEnabled();
  await sync.click();
  await expect
    .poll(() =>
      picker.operations.some(({ kind, path }) => kind === 'write' && path === 'test_0008.xmp'),
    )
    .toBe(true);

  // Rating and flag shortcuts drive Filter's complete visible state cycle.
  await page.keyboard.press('4');
  await page.keyboard.press('p');
  await page.getByRole('button', { name: 'Filter: All' }).click();
  await expect(page.getByRole('button', { name: 'Filter: Picks' })).toBeVisible();
  await expect(page.getByRole('button', { name: SOURCE, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: TARGET, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter: Picks' }).click();
  await expect(page.getByRole('button', { name: 'Filter: 4+ stars' })).toBeVisible();
  await expect(page.getByRole('button', { name: SOURCE, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filter: 4+ stars' }).click();
  await expect(page.getByRole('button', { name: 'Filter: All' })).toBeVisible();
  await expectAssets(page);

  // Tablet presentation collapses the same actions into the overflow menu.
  await page.setViewportSize({ width: 1000, height: 900 });
  const more = page.getByRole('button', { name: 'More actions' });
  await expect(more).toBeVisible();
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('button', { name: 'Select' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Copy settings' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Paste settings' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Sync settings' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });

  // Exit Select mode, then a plain thumbnail action opens Preview.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: SOURCE, exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await expect(page.locator('.top-name')).toHaveText(SOURCE);
  await expectPreviewPixels(page.locator('.preview-img').last());

  const filmstrip = page.locator('editor-filmstrip');
  const sourceThumb = filmstrip.getByRole('button', { name: SOURCE, exact: true });
  const targetThumb = filmstrip.getByRole('button', { name: TARGET, exact: true });
  await expect(sourceThumb).toHaveAttribute('aria-current', 'true');
  await targetThumb.click();
  await expect(page.locator('.top-name')).toHaveText(TARGET);
  await expect(targetThumb).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.top-name')).toHaveText(SOURCE);

  const filmstripToggle = page.getByRole('button', { name: 'Hide filmstrip' });
  await filmstripToggle.click();
  await expect(page.getByRole('button', { name: 'Show filmstrip' })).toBeVisible();
  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  await expect(sourceThumb).toBeVisible();

  const info = page.getByRole('button', { name: 'Info', exact: true });
  await expect(info).toHaveAttribute('aria-pressed', 'true');
  await info.click();
  await expect(info).toHaveAttribute('aria-pressed', 'false');
  await info.click();
  await expect(info).toHaveAttribute('aria-pressed', 'true');

  const flag = page.getByRole('button', { name: 'Flag', exact: true });
  await flag.click();
  await expect(flag).toHaveAttribute('aria-expanded', 'true');
  await page
    .locator('#preview-flag-popover')
    .getByRole('button', { name: 'Reject', exact: true })
    .click();
  await waitForXmpWrite(page, sourceXmp, /papp:Flag="reject"/);

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expectAssets(page);
  expect(apiRequests).toEqual([]);
  await verifyOriginalRawHashes(manifest);
  await verifyStagedRawHashes(manifest);
});

test('Hosted Browse one-RAW import enters the editor without a filmstrip', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo.project.name);
  test.setTimeout(180_000);
  const manifest = await readProductionFixtureManifest();
  const raw = manifest.sourceHashes.find(({ path }) => basename(path) === 'test_0004.fff');
  expect(raw).toBeDefined();

  await page.goto('/browse');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import RAW files' }).click();
  await (await chooser).setFiles(raw!.path);

  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.top-name')).toHaveText('test_0004.fff');
  await expect(page.locator('editor-filmstrip')).toHaveCount(0);
  await expect(page.getByText(/Download XMP/i)).toBeVisible();
  await verifyOriginalRawHashes(manifest);
});
