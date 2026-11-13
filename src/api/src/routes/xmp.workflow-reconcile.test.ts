/** A stale commit is reconciled onto the file on disk instead of refused (#4983). */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../fs/mirrored';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNative, shutdownMaplePool } from 'maple';
import { xmpPathRoutes } from './xmp';
import { setLibraryRootsForTests } from '../indexer/libraries.cache';

interface Entry {
  id: string;
  action: string;
  adjustmentXmp: string;
  parentId: string;
  writer: string;
}
const xml = await fs.readFile(
  new URL('../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp', import.meta.url),
  'utf8',
);
const ANCHOR = 'crs:ProcessVersion="15.4"';
const app = new Elysia().use(xmpPathRoutes);
const oldRoots = process.env.MAPLE_ROOTS;
let directory: string;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-workflow-reconcile-')));
  process.env.MAPLE_ROOTS = directory;
  setLibraryRootsForTests(new Map([['workflow-reconcile', directory]]));
  await fs.writeFile(join(directory, 'photo.dng'), new Uint8Array([1, 0, 255, 42]));
  await fs.writeFile(join(directory, 'photo.xmp'), xml);
});
afterEach(async () => {
  shutdownMaplePool();
  setLibraryRootsForTests(null);
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await fs.rm(directory, { recursive: true, force: true });
});

const sidecar = () => join(directory, 'photo.xmp');
const post = (operation: string, body: unknown) =>
  app.handle(
    new Request(
      `http://localhost/api/xmp/variant/${operation}?path=${encodeURIComponent(join(directory, 'photo.dng'))}&variantId=primary`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
const native = async (method: 'workflowCheckpointXmp' | 'workflowReadXmp', input: string) => {
  const result = await callNative(method, [input]);
  if (!result.ok) throw Error(result.error);
  return result.value;
};
const history = async (document: string): Promise<Entry[]> =>
  JSON.parse(await native('workflowReadXmp', document)).history;
const withAttribute = (document: string, attribute: string) =>
  document.replace(ANCHOR, `${ANCHOR} ${attribute}`);
const entryFor = async (document: string, label: string, kind = 'adjustment') => ({
  id: crypto.randomUUID(),
  createdAtMs: 10,
  action: kind,
  label,
  writer: 'web',
  adjustmentXmp: await native('workflowCheckpointXmp', document),
});
const commit = async (expectedXmp: string | null, document: string, label: string) => {
  const entry = await entryFor(document, label);
  const response = await post('commit', { expectedXmp, xmp: document, entry });
  return { entry, response };
};
const baseline = async () => {
  const { response } = await commit(xml, xml, 'Open');
  expect(response.status).toBe(200);
  return response.text();
};

test('two clients from one base keep both entries and both edits as a fork', async () => {
  const base = await baseline();
  const [open] = await history(base);
  const first = await commit(base, withAttribute(base, 'crs:Exposure2012="1.5"'), 'Exposure');
  expect(first.response.status).toBe(200);
  const second = await commit(base, withAttribute(base, 'crs:Contrast2012="12"'), 'Contrast');
  expect(second.response.status).toBe(200);
  const published = await second.response.text();
  expect(published).toBe(await fs.readFile(sidecar(), 'utf8'));
  expect(published).toContain('crs:Exposure2012="1.5"');
  expect(published).toContain('crs:Contrast2012="12"');
  const rows = await history(published);
  expect(rows.map((row) => row.id)).toEqual([open.id, first.entry.id, second.entry.id]);
  expect(rows[2].parentId).toBe(open.id);
  expect(rows[2].writer).toBe('web');
  expect(rows[2].adjustmentXmp).toBe(await native('workflowCheckpointXmp', published));
  expect(await fs.readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

test('an outside edit is recorded as an external entry and stays restorable', async () => {
  const base = await baseline();
  const outside = withAttribute(base, 'crs:Sharpness="40"');
  await fs.writeFile(sidecar(), outside);
  const { entry, response } = await commit(
    base,
    withAttribute(base, 'crs:Exposure2012="0.75"'),
    'Exposure',
  );
  expect(response.status).toBe(200);
  const published = await response.text();
  expect(published).toContain('crs:Sharpness="40"');
  expect(published).toContain('crs:Exposure2012="0.75"');
  const rows = await history(published);
  expect(rows.map((row) => row.action)).toEqual(['adjustment', 'external', 'adjustment']);
  expect(rows[2].id).toBe(entry.id);
  const external = rows[1];
  const restored = await post('restore', {
    expectedXmp: published,
    entry: {
      id: crypto.randomUUID(),
      createdAtMs: 20,
      action: 'history-restore',
      label: 'Back to outside edit',
      writer: 'web',
      adjustmentXmp: external.adjustmentXmp,
    },
  });
  expect(restored.status).toBe(200);
  const restoredXml = await restored.text();
  expect(restoredXml).toContain('crs:Sharpness="40"');
  expect(restoredXml).not.toContain('crs:Exposure2012="0.75"');
});

test('unknown attributes and child elements survive a reconciled commit byte for byte', async () => {
  const base = await baseline();
  const attribute = 'crs:VendorKnob="a &amp; b"';
  const element =
    '<crs:VendorBlock><rdf:Seq><rdf:li>keep  this &amp; that</rdf:li></rdf:Seq></crs:VendorBlock>';
  const outside = withAttribute(base, attribute).replace(
    '<crs:MaskGroupBasedCorrections>',
    `${element}<crs:MaskGroupBasedCorrections>`,
  );
  expect(outside).toContain(element);
  await fs.writeFile(sidecar(), outside);
  const { response } = await commit(base, withAttribute(base, 'crs:Exposure2012="2"'), 'Exposure');
  expect(response.status).toBe(200);
  const published = await response.text();
  expect(published).toContain(attribute);
  expect(published).toContain(element);
  expect(published).toContain('<crs:MaskGroupBasedCorrections>');
  expect(published).toContain('crs:Exposure2012="2"');
});

test('N concurrent commits from one base all land and none is rejected', async () => {
  const base = await baseline();
  const attributes = [
    'Exposure2012="1"',
    'Contrast2012="2"',
    'Highlights2012="-3"',
    'Shadows2012="4"',
    'Whites2012="5"',
    'Blacks2012="-6"',
    'Clarity2012="7"',
    'Vibrance="8"',
  ];
  const results = await Promise.all(
    attributes.map((attribute) => commit(base, withAttribute(base, `crs:${attribute}`), attribute)),
  );
  expect(results.map((row) => row.response.status)).toEqual(attributes.map(() => 200));
  const saved = await fs.readFile(sidecar(), 'utf8');
  for (const attribute of attributes) expect(saved).toContain(`crs:${attribute}`);
  const ids = (await history(saved)).map((row) => row.id);
  for (const { entry } of results) expect(ids).toContain(entry.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('a retried commit id is acknowledged without a duplicate entry or a write', async () => {
  const base = await baseline();
  const first = await commit(base, withAttribute(base, 'crs:Exposure2012="1.5"'), 'Exposure');
  const second = await commit(base, withAttribute(base, 'crs:Contrast2012="12"'), 'Contrast');
  const published = await second.response.text();
  const before = await history(published);
  for (const { entry } of [first, second]) {
    const retry = await post('commit', {
      expectedXmp: base,
      xmp: withAttribute(base, 'crs:Contrast2012="12"'),
      entry,
    });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(published);
  }
  expect(await fs.readFile(sidecar(), 'utf8')).toBe(published);
  expect(await history(published)).toEqual(before);
});

test('snapshot and restore stay strict, a deleted file still conflicts and a future record fails closed', async () => {
  const base = await baseline();
  const moved = await commit(base, withAttribute(base, 'crs:Exposure2012="1.5"'), 'Exposure');
  const current = await moved.response.text();
  const snapshot = {
    id: crypto.randomUUID(),
    name: 'Checkpoint',
    createdAtMs: 11,
    adjustmentXmp: await native('workflowCheckpointXmp', base),
  };
  expect((await post('snapshot', { expectedXmp: base, snapshot })).status).toBe(409);
  const restore = await entryFor(base, 'Back', 'history-restore');
  expect((await post('restore', { expectedXmp: base, entry: restore })).status).toBe(409);
  expect(await fs.readFile(sidecar(), 'utf8')).toBe(current);

  const future = current.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3');
  expect(future).not.toBe(current);
  await fs.writeFile(sidecar(), future);
  const stale = await commit(base, withAttribute(base, 'crs:Contrast2012="12"'), 'Contrast');
  expect(stale.response.status).toBe(422);
  expect(await fs.readFile(sidecar(), 'utf8')).toBe(future);

  await fs.unlink(sidecar());
  const gone = await commit(base, withAttribute(base, 'crs:Contrast2012="12"'), 'Contrast');
  expect(gone.response.status).toBe(409);
  await expect(fs.readFile(sidecar())).rejects.toMatchObject({ code: 'ENOENT' });
});
