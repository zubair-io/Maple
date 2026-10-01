import { expect, test } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PartialWbBrowserTest } from './main';

declare global {
  interface Window {
    partialWbTest: PartialWbBrowserTest;
  }
}
for (const name of ['source', 'target']) {
  for (const version of [1, 2, 3, 4, 5]) {
    for (const axis of [
      'crs:Temperature="8500"',
      'crs:Tint="40"',
      'crs:Temperature="6500"',
      'crs:Tint="0"',
    ]) {
      test(`WebGPU ${name} V${version} ${axis} retains the existing core resolution`, async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await page.waitForFunction(() => window.partialWbTest?.ready);
        const raw = Array.from(
          readFileSync(
            resolve(process.cwd(), '../../test-fixtures/batch-transfer/' + name + '.dng'),
          ),
        );
        const result = await page.evaluate(
          ({ raw, axis, version }) => window.partialWbTest.check(raw, axis, version),
          { raw, axis, version },
        );
        mkdirSync(testInfo.outputDir, { recursive: true });
        const pixelsPath = testInfo.outputPath('pixels.json');
        writeFileSync(pixelsPath, JSON.stringify(result));
        await testInfo.attach('pixels', { path: pixelsPath, contentType: 'application/json' });
        expect(result.colorSpace).toBe('srgb');
        expect(Math.abs(result.camera.tint)).toBeGreaterThan(0.5);
        expect(result.saved).not.toContain(
          axis.includes('Temperature') ? 'crs:Tint=' : 'crs:Temperature=',
        );
        expect(result.live.length).toBe(result.reference.length);
        const differences = result.live.map((value, i) => Math.abs(value - result.reference[i]));
        expect(Math.max(...differences)).toBeLessThanOrEqual(4);
        expect(
          differences.reduce((sum, value) => sum + value, 0) / differences.length,
        ).toBeLessThanOrEqual(2);
      });
    }
  }
}

for (const name of ['source', 'target']) {
  for (const [temperature, tint] of [
    [6500, 0],
    [8500, 40],
    [5000, -20],
  ]) {
    test(`WebGPU scalar ${name} Custom ${temperature}/${tint} preserves explicit axes`, async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.partialWbTest?.ready);
      const raw = Array.from(
        readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer/' + name + '.dng')),
      );
      const axis = `crs:Temperature="${temperature}" crs:Tint="${tint}"`;
      const result = await page.evaluate(
        ({ raw, axis }) => window.partialWbTest.check(raw, axis, 5, true),
        { raw, axis },
      );
      // Scalar authorship must exactly match full-XMP GPU rendering, including
      // explicit 6500/0. Bound Auto's existing CPU/GPU fit delta separately.
      expect(result.live).toEqual(result.reference);
      const differences = result.live.map((value, i) => Math.abs(value - result.coreReference[i]));
      expect(Math.max(...differences)).toBeLessThanOrEqual(4);
    });
  }
}

for (const name of ['source', 'target']) {
  test(`WebGPU ${name} As Shot preserves the camera anchor`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.partialWbTest?.ready);
    const raw = Array.from(
      readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer/' + name + '.dng')),
    );
    const result = await page.evaluate(
      (raw) => window.partialWbTest.check(raw, '', 5, false, true),
      raw,
    );
    expect(result.saved).not.toContain('crs:Temperature=');
    expect(result.saved).not.toContain('crs:Tint=');
    const differences = result.live.map((value, i) => Math.abs(value - result.reference[i]));
    expect(Math.max(...differences)).toBeLessThanOrEqual(4);
    expect(
      differences.reduce((sum, value) => sum + value, 0) / differences.length,
    ).toBeLessThanOrEqual(2);
  });
}
