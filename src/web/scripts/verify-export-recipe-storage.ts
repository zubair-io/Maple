/** Real Chromium IndexedDB reload/transaction proof; no fake storage or application server. */
import { chromium } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'export-recipe-storage.entry.ts')],
  target: 'browser',
});
if (!built.success) throw new AggregateError(built.logs, 'Recipe storage harness build failed');
const javascript = await built.outputs[0].text();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === '/store.js'
      ? new Response(javascript, { headers: { 'Content-Type': 'text/javascript' } })
      : new Response(
          '<!doctype html><title>Recipe storage verification</title><script src="/store.js"></script>',
          { headers: { 'Content-Type': 'text/html' } },
        );
  },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url.href);
  const written = await page.evaluate(async () => {
    const api = (globalThis as any).recipeStorage;
    const recipe = { ...api.defaultRecipe, name: 'Reload test', watermark: 'unsupported retained' };
    await api.saveRecipe(recipe);
    const queue = {
      id: 'persisted-queue',
      recipe,
      serverJobId: null,
      cancelled: true,
      targets: [0, 1, 2].map((index) => ({
        id: String(index),
        filename: `${index}.dng`,
        path: null,
        xmp: `<rdf:Description papp:GeoScale="1.2" crs:Exposure2012="${index}"/>`,
        filmLook: 'kodak-portra-400',
        capturedAt: null,
        index,
      })),
      entries: [
        { id: '0', status: 'applied' },
        { id: '1', status: 'rendering' },
        { id: '2', status: 'delivering', filename: '2.jpg' },
      ],
    };
    await api.saveExportQueue(queue);
    return { recipe, queue };
  });
  await page.reload();
  const recovered = await page.evaluate(async () => {
    const api = (globalThis as any).recipeStorage;
    const recipes = await api.savedRecipes();
    const persisted = await api.readExportQueue();
    return { recipes, persisted, recovered: api.recoverBrowserQueue(persisted) };
  });
  assert.deepEqual(recovered.recipes, [written.recipe]);
  assert.deepEqual(recovered.persisted, written.queue);
  assert.deepEqual(recovered.recovered.targets, written.queue.targets);
  assert.deepEqual(
    recovered.recovered.entries.map((entry: any) => entry.status),
    ['applied', 'pending', 'failed'],
  );
  assert.match(recovered.recovered.entries[2].reason, /outcome unknown/);
  await page.evaluate(async () => {
    const api = (globalThis as any).recipeStorage;
    await api.deleteRecipe('Reload test');
  });
  await page.reload();
  assert.deepEqual(await page.evaluate(() => (globalThis as any).recipeStorage.savedRecipes()), []);
  console.log(
    'PASS: real browser recipe round-trip, committed queue reload, immutable edits, uncertain download recovery and deletion',
  );
  await context.close();
} finally {
  await browser.close();
  await server.stop();
}
