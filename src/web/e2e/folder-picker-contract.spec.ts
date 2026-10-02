import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { installProductionFolderPicker } from './support/production-folder-picker';

test('missing folder files reject with Chrome DOMException before exposing a handle', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'maple-picker-contract-'));
  try {
    await installProductionFolderPicker(page, root);
    await page.goto('about:blank');
    const failure = await page.evaluate(async () => {
      const picker = window as typeof window & {
        showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
      };
      const folder = await picker.showDirectoryPicker();
      try {
        await folder.getFileHandle('missing.xmp');
        return null;
      } catch (error) {
        return { domException: error instanceof DOMException, name: (error as Error).name };
      }
    });
    expect(failure).toEqual({ domException: true, name: 'NotFoundError' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file removed after acquisition rejects getFile with Chrome DOMException', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'maple-picker-contract-'));
  const path = join(root, 'removed.xmp');
  await writeFile(path, '<x:xmpmeta/>');
  try {
    await installProductionFolderPicker(page, root);
    await page.goto('about:blank');
    await page.evaluate(async () => {
      const picker = window as typeof window & {
        showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
        acquiredFile?: FileSystemFileHandle;
      };
      picker.acquiredFile = await (await picker.showDirectoryPicker()).getFileHandle('removed.xmp');
      const file = await picker.acquiredFile.getFile();
      const bytes = new TextDecoder().decode(await file.arrayBuffer());
      if (bytes !== '<x:xmpmeta/>') throw new Error('Adapter did not read the real fixture');
    });
    await rm(path);
    const failure = await page.evaluate(async () => {
      const picker = window as typeof window & { acquiredFile: FileSystemFileHandle };
      try {
        await picker.acquiredFile.getFile();
        return null;
      } catch (error) {
        return { domException: error instanceof DOMException, name: (error as Error).name };
      }
    });
    expect(failure).toEqual({ domException: true, name: 'NotFoundError' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
