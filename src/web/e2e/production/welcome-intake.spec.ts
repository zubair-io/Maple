import type { Page } from '@playwright/test';
import { expect, test } from '../support/production-test';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function hostedOnly(projectName: string): void {
  test.skip(projectName !== 'chrome-hosted');
}

function watchServerOnlyActivity(page: Page): {
  requests: string[];
  dialogs: string[];
} {
  const requests: string[] = [];
  const dialogs: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/fs/list') requests.push(request.url());
  });
  page.on('dialog', (dialog) => dialogs.push(dialog.type()));
  return { requests, dialogs };
}

test('installed-PWA launch contract opens an accessible Hosted welcome', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo.project.name);
  const activity = watchServerOnlyActivity(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Maple', level: 1 })).toBeVisible();
  const openPhoto = page.getByRole('button', { name: /open a photo/i });
  const openFolder = page.getByRole('button', { name: /open a folder/i });
  await expect(openPhoto).toBeVisible();
  await expect(openFolder).toBeVisible();

  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
    id: string;
    scope: string;
    start_url: string;
    display: string;
  };
  expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/', display: 'standalone' });

  await openPhoto.focus();
  await expect(openPhoto).toBeFocused();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('notes'),
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('notes.txt');
  await expect(alert).toContainText('not a supported RAW or image file');

  expect(activity).toEqual({ requests: [], dialogs: [] });
});

test('picker and drop files use the same direct-to-editor intake', async ({ page }, testInfo) => {
  hostedOnly(testInfo.project.name);
  const activity = watchServerOnlyActivity(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /open a photo/i }).click();
  await (
    await chooserPromise
  ).setFiles({
    name: 'picked.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect(page).toHaveURL(/\/edit\/[^/]+$/);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('section').evaluate((section, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    section.dispatchEvent(event);
  }, Array.from(PNG_1X1));
  await expect(page).toHaveURL(/\/edit\/[^/]+$/);

  expect(activity).toEqual({ requests: [], dialogs: [] });
});

test('picker and drop folders use the same writable workspace path', async ({ page }, testInfo) => {
  hostedOnly(testInfo.project.name);
  const activity = watchServerOnlyActivity(page);
  await page.addInitScript(() => {
    const folder = {
      kind: 'directory',
      name: 'Picker RAWs',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      async *entries() {},
      getDirectoryHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
    };
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => folder,
    });
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page).toHaveURL(/\/browse$/);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('section').evaluate((section) => {
    const folder = {
      kind: 'directory',
      name: 'Dropped RAWs',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      async *entries() {},
      getDirectoryHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        items: [{ getAsFileSystemHandle: async () => folder }],
        files: [],
      },
    });
    section.dispatchEvent(event);
  });
  await expect(page).toHaveURL(/\/browse$/);

  expect(activity).toEqual({ requests: [], dialogs: [] });
});

test('permission and unreadable failures name the input and recover', async ({
  page,
}, testInfo) => {
  hostedOnly(testInfo.project.name);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      },
    });
  });
  await page.goto('/');

  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page.getByRole('alert')).toContainText('the selected folder');
  await expect(page.getByRole('alert')).toContainText('permission was denied or lost');

  await page.locator('section').evaluate((section) => {
    const file = new File(['raw'], 'unreadable.DNG', { type: 'image/x-adobe-dng' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        throw new DOMException('The file is no longer readable.', 'NotReadableError');
      },
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    section.dispatchEvent(event);
  });
  await expect(page.getByRole('alert')).toContainText('unreadable.DNG');
  await expect(page.getByRole('alert')).toContainText('no longer readable');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /open a photo/i }).click();
  await (
    await chooserPromise
  ).setFiles({
    name: 'retry.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect(page).toHaveURL(/\/edit\/[^/]+$/);
});
