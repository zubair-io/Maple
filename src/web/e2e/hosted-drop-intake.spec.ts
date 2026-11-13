// #4675 — a browser-owned file drop (CDP Input.dispatchDragEvent) must reach
// the Hosted landing's intake. Synthetic `new DataTransfer()` drops never lock,
// so only a real drag catches code that reads the DataTransfer after an await.

import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('a real OS file drop on the landing opens the dropped photo', async ({ page }) => {
  const droppedFile = join(mkdtempSync(join(tmpdir(), 'maple-drop-')), 'dropped.png');
  writeFileSync(droppedFile, PNG_1X1);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const box = await page.locator('section').first().boundingBox();
  if (!box) throw new Error('landing section has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [droppedFile], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });

  await expect(page).toHaveURL(/\/edit\/[^/]+$/);
});
