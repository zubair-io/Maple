// Real production pixels and worker messages; no renderer or canvas mocks.
// Generate the 2048x1366 fixture and serve the Hosted artifact as in docs/zoom.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [url, fixture] = process.argv.slice(2);
if (!url || !fixture)
  throw new Error('Usage: node scripts/check-native-detail-browser.mjs URL DNG');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultNavigationTimeout(60_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  delete Object.getPrototypeOf(navigator).gpu;
  delete navigator.gpu;
  window.detailAudit = { requests: [], responses: [], draws: [], panEvents: [], closed: 0 };
  document.addEventListener(
    'wheel',
    (event) => {
      if (event.target.closest('editor-image-canvas') && !event.ctrlKey && !event.metaKey)
        window.detailAudit.panEvents.push(performance.now());
    },
    { capture: true },
  );
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'native-detail-success')
          window.detailAudit.responses.push({ at: performance.now(), id: data.id });
      });
    }
    postMessage(data, ...args) {
      if (data.type === 'native-detail')
        window.detailAudit.requests.push({
          at: performance.now(),
          id: data.id,
          sourceId: data.sourceId,
          rect: data.rect,
          bytes: !!data.bytes,
        });
      if (data.type === 'close-native-detail') window.detailAudit.closed++;
      return super.postMessage(data, ...args);
    }
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
    if (this.canvas.closest('editor-image-canvas'))
      window.detailAudit.draws.push({
        at: performance.now(),
        w: image.width,
        h: image.height,
        args,
      });
    return draw.call(this, image, ...args);
  };
});

const audit = () => page.evaluate(() => window.detailAudit);
const now = () => page.evaluate(() => performance.now());
const actualSize = () =>
  page.locator('editor-image-canvas .canvas-wrap').dispatchEvent('keydown', {
    key: '1',
    ctrlKey: true,
    bubbles: true,
  });
async function waitBase(after, minWidth = 1440) {
  await page.waitForFunction(
    ({ after, minWidth }) =>
      window.detailAudit.draws.some((d) => d.at > after && d.w >= minWidth && d.w <= 1440),
    { after, minWidth },
    { timeout: 120_000 },
  );
}
async function waitPatch(id) {
  await page.waitForFunction((id) => window.detailAudit.responses.some((r) => r.id === id), id, {
    timeout: 120_000,
  });
}
async function nextRequest(count) {
  await page.waitForFunction((n) => window.detailAudit.requests.length > n, count, {
    timeout: 30_000,
  });
  return (await audit()).requests.at(-1);
}

try {
  await page.goto(url);
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.waitForURL(/\/edit\//);
  await waitBase(0);
  await actualSize();
  const first = await nextRequest(0);
  await waitPatch(first.id);
  await page.waitForFunction(
    (rect) =>
      window.detailAudit.draws.some(
        (d) => d.w === rect.width && d.h === rect.height && d.args[2] === d.w && d.args[3] === d.h,
      ),
    first.rect,
    { timeout: 30_000 },
  );
  assert.equal(first.bytes, true);

  await page.mouse.move(720, 500);
  await page.mouse.wheel(450, 0);
  const pan = await nextRequest(1);
  await waitPatch(pan.id);
  const panned = await audit();
  const panStart = panned.panEvents.at(-1);
  assert.ok(Number.isFinite(panStart), 'time the actual browser input, excluding driver overhead');
  assert.equal(pan.bytes, false, 'pan must reuse the retained RAW');
  assert.notDeepEqual(pan.rect, first.rect);
  const basePaint = panned.draws.find((d) => d.at > panStart && d.w === 1440);
  assert.ok(basePaint, 'pan must repaint the base before refinement completes');
  const patchAt = panned.responses.find((r) => r.id === pan.id).at;
  assert.ok(basePaint.at < patchAt);
  await page.goBack();
  await page.waitForFunction(() => window.detailAudit.closed > 0);

  // Begin real synchronous WASM work, then switch photos before it returns.
  const reopenAt = await now();
  await page.locator('input[type=file]').setInputFiles([]);
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.waitForURL(/\/edit\//);
  await waitBase(reopenAt, 1024);
  const beforeRace = (await audit()).requests.length;
  await actualSize();
  const obsolete = await nextRequest(beforeRace);
  const previousUrl = page.url();
  await page.goBack();
  await page.locator('input[type=file]').setInputFiles({
    name: 'second-photo.dng',
    mimeType: 'image/x-adobe-dng',
    buffer: readFileSync(fixture),
  });
  await page.waitForURL(/\/edit\//);
  assert.notEqual(page.url(), previousUrl);
  const switchedAt = await now();
  await waitPatch(obsolete.id);
  await waitBase(switchedAt, 1024);
  const raced = await audit();
  assert.ok(
    raced.responses.find((r) => r.id === obsolete.id).at > switchedAt,
    'test must actually receive old pixels after switching photos',
  );
  assert.ok(
    !raced.draws.some(
      (d) => d.at > switchedAt && d.w === obsolete.rect.width && d.h === obsolete.rect.height,
    ),
    'obsolete native pixels must never paint on the new photo',
  );
  assert.ok(raced.closed >= 2, 'switch must release the old retained session');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      requests: raced.requests,
      released: raced.closed,
      panBasePaintMs: basePaint.at - panStart,
      panRefinementMs: patchAt - panStart,
      wrongAssetRacePassed: true,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), audit: await audit(), errors }));
  throw error;
} finally {
  await browser.close();
}
