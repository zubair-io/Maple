// #4112/#4123: real production Auto editor, canonical RAW, three 60Hz drags.
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '../support/production-test';
import { canonical100mpIdentity } from '../support/canonical-100mp';
import { installProductionFolderPicker } from '../support/production-folder-picker';
import { forceNoWebGpu, screenshotPixelEvidence } from '../support/raw-performance';
import {
  assertDetailSweep,
  fenceDetailRequests,
  installDetailPerformanceObserver,
  sweepDetail,
} from '../support/detail-performance';

const FIXTURE = 'dji-mavic3pro-100mp.dng';
const ARMS = [
  { arm: 'sharpen', label: 'Sharpen', maximum: 150 },
  { arm: 'nrColor', label: 'Color NR', maximum: 100 },
  { arm: 'nrLuminance', label: 'Noise', maximum: 100 },
] as const;
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});

for (const route of ['gpu', 'cpu'] as const) {
  test(`Canonical Auto 100MP detail 60Hz input/publication (${route})`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chrome-hosted');
    test.setTimeout(600_000);
    const source = resolve(__dirname, '../../../../test-fixtures/raws', FIXTURE);
    const present = await access(source).then(
      () => true,
      () => false,
    );
    test.skip(!present, `${FIXTURE} is absent; no 100MP detail qualification was executed`);
    const identity = await canonical100mpIdentity(source);
    const folder = await mkdtemp(join(tmpdir(), 'maple-detail-perf-'));
    const report: any = {
      route,
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      identity,
      fixture: FIXTURE,
      browser: page.context().browser()?.version(),
      host: { cpu: cpus()[0]?.model, memoryBytes: totalmem() },
      arms: [],
      outcome: 'setup',
    };
    try {
      await copyFile(source, join(folder, FIXTURE));
      const picker = await installProductionFolderPicker(page, folder);
      await installDetailPerformanceObserver(page, identity.bytes);
      if (route === 'cpu') await forceNoWebGpu(page);
      await page.goto('/');
      const intake = await page.evaluate(async (filename) => {
        const dir = await (window as any).showDirectoryPicker();
        const file = await (await dir.getFileHandle(filename)).getFile();
        const bytes = await file.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return {
          bytes: bytes.byteLength,
          sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
        };
      }, FIXTURE);
      expect(intake).toEqual(identity);
      picker.clear();
      await page.getByRole('button', { name: /open a folder/i }).click();
      await page.getByRole('button', { name: FIXTURE, exact: true }).click({ timeout: 120_000 });
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('button', { name: 'Color', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await page.getByRole('button', { name: 'Detail', exact: true }).click();
      await expect(page.getByRole('slider', { name: 'Sharpen', exact: true })).toBeVisible();
      await fenceDetailRequests(page);
      const canvas = page.locator('editor-image-canvas canvas').first();
      const pixels = await screenshotPixelEvidence(canvas);
      expect(pixels.range).toBeGreaterThan(20);
      expect(pixels.nonDarkFraction).toBeGreaterThan(0.05);
      const initial = await page.evaluate(() => (window as any).__detailPerf);
      const open = initial.replies.find(
        (r: any) => r.type === (route === 'gpu' ? 'open-session-success' : 'decode-success'),
      );
      expect(open).toBeTruthy();
      expect(open.nativeWidth * open.nativeHeight).toBe(100_663_296);
      expect((await canvas.getAttribute('data-gpu-live')) !== null).toBe(route === 'gpu');
      report.open = open;
      report.rawWorkerToken = initial.worker;
      expect(initial.worker).toBeTruthy();
      report.viewport = await canvas.evaluate((el) => ({
        width: (el as HTMLCanvasElement).width,
        height: (el as HTMLCanvasElement).height,
        devicePixelRatio,
      }));
      for (const arm of ARMS) {
        // Restore every detail default through the authored UI before each arm.
        // No model/service injection and no accumulated preceding sweep settings.
        for (const reset of ARMS)
          await page.getByRole('slider', { name: reset.label, exact: true }).dblclick();
        await fenceDetailRequests(page);
        await expect(page.getByRole('slider', { name: 'Sharpen', exact: true })).toHaveAttribute(
          'aria-valuenow',
          '40',
        );
        await expect(page.getByRole('slider', { name: 'Color NR', exact: true })).toHaveAttribute(
          'aria-valuenow',
          '25',
        );
        await expect(page.getByRole('slider', { name: 'Noise', exact: true })).toHaveAttribute(
          'aria-valuenow',
          '0',
        );
        const measured = await sweepDetail(
          page,
          page.getByRole('slider', { name: arm.label, exact: true }),
          arm.arm,
          arm.maximum,
          route,
        );
        report.arms.push(measured);
      }
      for (const measured of report.arms) assertDetailSweep(measured);
      report.outcome = 'passed';
    } catch (error) {
      report.outcome = 'failed';
      report.error = String(error);
      report.failureObserver = await page
        .evaluate(() => (window as any).__detailPerf)
        .catch(() => null);
      throw error;
    } finally {
      report.originalAfter = await canonical100mpIdentity(source);
      expect(report.originalAfter).toEqual(identity);
      await info.attach(`detail-100mp-${route}.json`, {
        body: Buffer.from(JSON.stringify(report, null, 2)),
        contentType: 'application/json',
      });
      await rm(folder, { recursive: true, force: true });
    }
  });
}
