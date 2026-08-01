import type { Page } from '@playwright/test';
import { expect } from './production-test';

/** Open a folder already installed by the production folder-picker fixture. */
export async function openHostedFolder(page: Page, filename: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /open a folder/i }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.getByRole('button', { name: filename, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

/** Open one folder asset in the shared full editor. */
export async function openHostedFolderEditor(page: Page, filename: string): Promise<void> {
  await openHostedFolder(page, filename);
  await page.getByRole('button', { name: filename, exact: true }).click();
  await expect(page).toHaveURL(/\/view\//);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible({ timeout: 60_000 });
}
