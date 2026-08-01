import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { readProductionFixtureManifest } from './production-fixtures';
import { installProductionFolderPicker } from './production-folder-picker';
import { openHostedFolderEditor } from './production-editor';

export const EDITOR_ACTION_FILENAME = 'test_0006.DNG';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function openDisposableHostedEditor(page: Page, ledgerName: string) {
  const manifest = await readProductionFixtureManifest();
  const folder = join(manifest.root, ledgerName);
  const rawPath = join(folder, EDITOR_ACTION_FILENAME);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await copyFile(join(manifest.freshFolder, EDITOR_ACTION_FILENAME), rawPath);
  const originalHash = await sha256File(rawPath);
  await installProductionFolderPicker(page, folder);
  await openHostedFolderEditor(page, EDITOR_ACTION_FILENAME);
  return { folder, rawPath, originalHash };
}
