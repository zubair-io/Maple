import { expectProfileCanvas } from './profile-canvas-proof';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

for (const gpu of [false, true]) {
  test(`${gpu ? 'GPU live' : 'CPU'} resolves imported Auto WB and preserves omitted sidecar axes`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    const raw = 'test_0007.DNG';
    const sidecar = 'test_0007.xmp';
    const fixture = resolve('../../test-fixtures/raws', raw);
    test.skip(!existsSync(fixture), 'Physical RAW fixture is not installed');
    const bytes = readFileSync(fixture);
    const xml =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Auto" papp:Profile="Neutral"/></rdf:RDF></x:xmpmeta>';
    await page.route('**/physical-raw/' + raw, (route) => route.fulfill({ body: bytes }));
    await page.route('**/physical-raw/' + sidecar, (route) => route.fulfill({ body: xml }));
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'coldProfileUI')?.ready);
    const folder = await page.evaluate(
      ({ raw, sidecar, gpu }) =>
        Reflect.get(window, 'coldProfileUI').mount([raw, sidecar], undefined, gpu),
      { raw, sidecar, gpu },
    );
    await page.getByTitle('Fit (⌘0)', { exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = await Reflect.get(window, 'coldProfileUI').state();
            return (
              !!state.rendered &&
              state.rendered === state.expected &&
              (state.gpuActive || state.bitmap)
            );
          }),
        { timeout: 120000 },
      )
      .toBe(true);
    const expected = await page.evaluate(
      (raw) => Reflect.get(window, 'coldProfileUI').estimateWhiteBalance(raw),
      raw,
    );
    const state = await page.evaluate(() => Reflect.get(window, 'coldProfileUI').state());
    expect(state.gpuActive).toBe(gpu);
    expect(state.whiteBalance).toEqual({
      preset: 'Auto',
      temperature: expected.temperature,
      tint: expected.tint,
    });
    expect(state.partialWhiteBalance).toEqual({ version: 5 });
    await expectProfileCanvas(page, gpu);
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').authorExposure());
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').state());
    const persisted = await page.evaluate(
      async ({ folder, raw, sidecar }) => {
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
        const text = await (await (await directory.getFileHandle(sidecar)).getFile()).text();
        const rawBytes = await (await (await directory.getFileHandle(raw)).getFile()).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', rawBytes);
        return {
          text,
          hash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''),
        };
      },
      { folder, raw, sidecar },
    );
    expect(persisted.text).toContain('crs:WhiteBalance="Auto"');
    expect(persisted.text).toContain('crs:Exposure2012="1.25"');
    expect(persisted.text).not.toMatch(/crs:(Temperature|Tint)=/);
    expect(persisted.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').authorWhiteBalance());
    const authored = await page.evaluate(() => Reflect.get(window, 'coldProfileUI').state());
    expect(authored.whiteBalance).toEqual({ preset: 'Custom', temperature: 4800, tint: 12 });
    expect(authored.partialWhiteBalance).toBeNull();
    await page.evaluate(() => Reflect.get(window, 'coldProfileUI').dispose());
  });
}

test('failed mount releases the held frame and destroys the qualification app', async ({
  page,
}) => {
  await page.route('**/physical-raw/missing-fixture.dng', (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto('http://localhost:4520');
  await page.waitForFunction(() => Reflect.get(window, 'coldProfileUI')?.ready);
  const errors = await page.evaluate(async () => {
    const ui = Reflect.get(window, 'coldProfileUI');
    const messages: string[] = [];
    try {
      await ui.mount(['missing-fixture.dng'], undefined, false, true);
    } catch (error) {
      messages.push(String(error));
    }
    try {
      ui.release();
    } catch (error) {
      messages.push(String(error));
    }
    try {
      await ui.state();
    } catch (error) {
      messages.push(String(error));
    }
    await ui.dispose();
    return messages;
  });
  expect(errors).toEqual([
    'Error: Missing physical fixture: missing-fixture.dng',
    'Error: No pending frame',
    'Error: No Auto fixture mounted',
  ]);
  await expect(page.locator('cold-profile-qualification')).toHaveCount(0);
});

for (const gpu of [false, true]) {
  for (const authored of [false, true]) {
    test(`${gpu ? 'GPU live' : 'CPU'} ${authored ? 'Custom WB' : 'As Shot'} applies Auto selected while reopening a real Neutral RAW`, async ({
      page,
    }) => {
      test.setTimeout(240000);
      const files = ['test_0007.DNG'];
      const fixture = resolve('../../test-fixtures/raws', files[0]);
      test.skip(!existsSync(fixture), 'Physical RAW fixture is not installed');
      const bytes = readFileSync(fixture);
      await page.route('**/physical-raw/' + files[0], (route) =>
        route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
      );
      await page.goto('http://localhost:4520');
      await page.waitForFunction(() => Reflect.get(window, 'coldProfileUI')?.ready);
      const name = await page.evaluate(
        ({ files, gpu }) => Reflect.get(window, 'coldProfileUI').mount(files, undefined, gpu),
        { files, gpu },
      );
      await page.getByTitle('Fit (⌘0)', { exact: true }).click();
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const state = await Reflect.get(window, 'coldProfileUI').state();
              return (
                !!state.rendered &&
                state.rendered === state.expected &&
                (state.gpuActive || state.bitmap)
              );
            }),
          { timeout: 120000 },
        )
        .toBe(true);
      if (authored)
        await page.evaluate(() => Reflect.get(window, 'coldProfileUI').authorWhiteBalance());
      await page.getByRole('radio', { name: 'Neutral', exact: true }).click();
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const state = await Reflect.get(window, 'coldProfileUI').state();
              return state.profile === 'Neutral' && state.rendered === state.expected;
            }),
          { timeout: 120000 },
        )
        .toBe(true);
      await page.evaluate(
        ({ files, name, gpu }) =>
          Reflect.get(window, 'coldProfileUI').mount(files, name, gpu, true),
        { files, name, gpu },
      );
      await page.getByTitle('Fit (⌘0)', { exact: true }).click();
      await expect
        .poll(
          () =>
            page.evaluate(async () => (await Reflect.get(window, 'coldProfileUI').state()).pending),
          { timeout: 120000 },
        )
        .toBe(true);
      await expect(page.getByRole('radio', { name: 'Neutral', exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await page.getByRole('radio', { name: 'Auto', exact: true }).click();
      await page.evaluate(() => Reflect.get(window, 'coldProfileUI').release());
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const state = await Reflect.get(window, 'coldProfileUI').state();
              return (
                state.completed && state.profile === 'Auto' && state.rendered === state.expected
              );
            }),
          { timeout: 120000 },
        )
        .toBe(true);
      const state = await page.evaluate(() => Reflect.get(window, 'coldProfileUI').state());
      expect(state.gpuActive).toBe(gpu);
      if (authored)
        expect(state.whiteBalance).toEqual({ preset: 'Custom', temperature: 4800, tint: 12 });
      expect(state.dispatched).toContain('papp:Profile="Neutral"');
      expect(state.gateIntent).toContain('papp:Profile="Neutral"');
      expect(state.edits.some((xmp: string) => xmp.includes('papp:Profile="Auto"'))).toBe(true);
      await expectProfileCanvas(page, gpu);
      await page.screenshot({ path: test.info().outputPath('auto-after-cold-open.png') });
      await page.evaluate(() => Reflect.get(window, 'coldProfileUI').dispose());
    });
  }
}
