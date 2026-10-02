// Actual Smart paint on a photographic RAW (#3984). This verifies selection
// and stroke history, not reconstruction of a portrait beyond native ROI limits.
import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installProductionFolderPicker } from '../support/production-folder-picker';

const fixture = resolve(__dirname, '../../../../test-fixtures/raws/test_0002.dng');
const modelRoot = process.env.MAPLE_REMOVAL_MODEL_DIR ?? '/tmp/maple-removal-models';
const models = [
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-encoder.onnx'),
  join(modelRoot, 'mobile-sam/native-build/mobile-sam-decoder.onnx'),
];

test('Smart paint stroke preserves selection after incompatible subtraction and replays its exact mask', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), 'maple-removal-smart-ui-'));
  const original = await readFile(fixture);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  try {
    await copyFile(fixture, join(root, 'portrait.dng'));
    await installProductionFolderPicker(page, root);
    await page.addInitScript(() => {
      const digests: Promise<string>[] = [];
      const events: object[] = [];
      Object.defineProperty(window, '__mapleSmartEvents', { value: events });
      for (const type of [
        'pointerdown',
        'pointerup',
        'pointercancel',
        'lostpointercapture',
        'gotpointercapture',
      ])
        document.addEventListener(
          type,
          (event) => {
            const pointer = event as PointerEvent;
            const target = event.target as HTMLElement;
            events.push({
              type,
              at: performance.now(),
              ancestors: [
                target.tagName,
                target.parentElement?.tagName,
                target.parentElement?.parentElement?.tagName,
              ],
              tag: target.tagName,
              role: target.getAttribute('role'),
              label: target.getAttribute('aria-label'),
              x: pointer.clientX,
              y: pointer.clientY,
            });
          },
          true,
        );
      Object.defineProperty(window, '__mapleSmartSelectionDigests', { value: digests });
      const Original = window.Worker;
      window.Worker = new Proxy(Original, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          const post = worker.postMessage.bind(worker);
          worker.postMessage = ((data: unknown, transfer: Transferable[]) => {
            const request = data as {
              type?: string;
              kind?: string;
              id?: unknown;
              command?: { kind?: string; request?: string };
            };
            const mapping =
              request.command?.kind === 'map' ? JSON.parse(request.command.request!) : undefined;
            events.push({
              direction: 'request',
              at: performance.now(),
              type: request?.type,
              kind: request?.kind ?? request.command?.kind,
              crop: mapping?.crop_input_size,
              points: mapping?.points.length < 10 ? mapping.points : mapping?.points.slice(0, 2),
              id: request?.id,
            });
            post(data, transfer);
          }) as typeof worker.postMessage;
          worker.addEventListener('message', ({ data }) => {
            const mapping =
              data?.value?.kind === 'map' ? JSON.parse(data.value.mapping) : undefined;
            events.push({
              direction: 'reply',
              at: performance.now(),
              id: data?.id,
              type: data?.type,
              kind: data?.value?.kind,
              points: mapping?.points.length < 10 ? mapping.points : mapping?.points.slice(0, 2),
              stage: data?.stage,
              error: data?.error ?? data?.message,
              maskBytes: data?.result instanceof Uint8Array ? data.result.length : undefined,
            });
            if (data?.result instanceof Uint8Array)
              digests.push(
                crypto.subtle
                  .digest('SHA-256', data.result)
                  .then((bytes) =>
                    Array.from(new Uint8Array(bytes), (byte) =>
                      byte.toString(16).padStart(2, '0'),
                    ).join(''),
                  ),
              );
          });
          return worker;
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /open a folder/i }).click();
    await page.getByRole('button', { name: 'portrait.dng', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const gpuCanvas = page.locator('canvas[data-gpu-live]');
    if (testInfo.project.name === 'removal-webgpu') await expect(gpuCanvas).toBeVisible();
    else {
      await expect(gpuCanvas).toHaveCount(0);
      await expect
        .poll(
          () =>
            page.locator('.canvas-wrap > canvas').evaluate((element) => {
              const canvas = element as HTMLCanvasElement;
              const pixel = canvas
                .getContext('2d')
                ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
              return !!pixel && pixel[3] === 255 && pixel[0] + pixel[1] + pixel[2] > 50;
            }),
          { timeout: 60_000 },
        )
        .toBe(true);
    }
    await page
      .getByRole('navigation', { name: 'Editor tools' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const panel = page.getByTestId('removal-panel');
    await panel.getByText('Local AI models', { exact: true }).click();
    await panel.getByLabel('Import local removal models').setInputFiles(models);
    await expect(
      panel.getByText('mobile-sam-decoder.onnx · Installed', { exact: false }),
    ).toBeVisible();
    await panel
      .getByRole('combobox', { name: 'Object selection mode', exact: true })
      .selectOption('smart');
    await expect(panel.getByRole('slider', { name: 'Brush size', exact: true })).toBeEnabled();
    const overlay = page.getByRole('img', { name: /Paint to select objects/ });
    const rect = await overlay.boundingBox();
    if (!rect) throw Error('Smart paint has no canvas bounds');
    const undo = panel.getByRole('button', { name: 'Undo selection stroke', exact: true });
    const redo = panel.getByRole('button', { name: 'Redo selection stroke', exact: true });
    const middle = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await page.mouse.move(middle.x - 4, middle.y);
    await page.mouse.down();
    await page.mouse.move(middle.x + 4, middle.y, { steps: 3 });
    await page.mouse.up();
    await expect(undo).toBeEnabled({ timeout: 120_000 });
    await expect(panel.getByRole('button', { name: 'Clear selection', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('smart-add-selection.png') });
    await panel.getByRole('button', { name: 'Paint to subtract selection', exact: true }).click();
    // Keep the positive prompt: painting over it deliberately empties intent.
    await page.mouse.click(rect.x + rect.width * 0.57, rect.y + rect.height * 0.6);
    // This pinned model cannot segment the face while excluding its chin.
    // A rejected candidate must preserve the prior mask and stroke history.
    await expect(
      panel.getByRole('status').filter({ hasText: 'smart selection: no candidate honors' }),
    ).toHaveText('smart selection: no candidate honors the positive and negative prompts', {
      timeout: 120_000,
    });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Clear selection', exact: true })).toBeEnabled();
    await undo.click();
    await expect(redo).toBeEnabled();
    await expect(undo).toBeDisabled();
    await expect(
      panel.getByRole('status').filter({ hasText: 'smart selection: no candidate honors' }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Clear selection', exact: true }),
    ).toBeDisabled();
    await redo.click();
    await expect(undo).toBeEnabled();
    await expect(
      panel.getByRole('status').filter({ hasText: 'smart selection: no candidate honors' }),
    ).toHaveCount(0);
    const digests = await page.evaluate(async () =>
      Promise.all(Reflect.get(window, '__mapleSmartSelectionDigests') as Promise<string>[]),
    );
    expect(digests).toHaveLength(2);
    expect(digests[1]).toBe(digests[0]);
    await page.screenshot({ path: testInfo.outputPath('smart-stroke-history.png') });
    expect(await readdir(root)).not.toContain('portrait.xmp');
    expect(await readFile(join(root, 'portrait.dng'))).toEqual(original);
    expect(failures).toEqual([]);
  } finally {
    await testInfo.attach('smart-paint-input-and-worker-audit', {
      body: Buffer.from(
        JSON.stringify(
          await page.evaluate(() => Reflect.get(window, '__mapleSmartEvents')),
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
    await rm(root, { recursive: true, force: true });
  }
});
