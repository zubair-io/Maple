import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNative, shutdownMaplePool } from 'maple';
import { xmpPathRoutes } from './xmp';
import { setLibraryRootsForTests } from '../indexer/libraries.cache';
import { writeXmpWithPrecondition } from '../fs/xmp';
import { WORKFLOW_MAX_BYTES, WORKFLOW_MAX_TIMESTAMP_MS } from '../generated/workflow.generated';

const corpus = JSON.parse(
  await readFile(
    new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
);
const xml = await readFile(
  new URL('../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp', import.meta.url),
  'utf8',
);
const app = new Elysia().use(xmpPathRoutes);
const oldRoots = process.env.MAPLE_ROOTS;
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-api-')));
  process.env.MAPLE_ROOTS = directory;
  setLibraryRootsForTests(new Map([['workflow-fixture', directory]]));
  await writeFile(join(directory, 'photo.dng'), new Uint8Array([1, 0, 255, 42]));
  await writeFile(join(directory, 'photo.xmp'), xml);
});
afterEach(async () => {
  shutdownMaplePool();
  setLibraryRootsForTests(null);
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(directory, { recursive: true, force: true });
});
const patch = (body: unknown) =>
  app.handle(
    new Request(
      'http://localhost/api/xmp/workflow?path=' + encodeURIComponent(join(directory, 'photo.dng')),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
const post = (body: string) =>
  app.handle(
    new Request(
      'http://localhost/api/xmp?path=' + encodeURIComponent(join(directory, 'photo.dng')),
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body },
    ),
  );

test('snapshot ingress rejects malformed fields before changing sidecars or original bytes', async () => {
  const snapshot = {
    id: crypto.randomUUID(),
    name: 'Saved checkpoint',
    createdAtMs: 11,
    adjustmentXmp: xml,
  };
  const malformed = [
    null,
    {},
    [],
    { ...snapshot, id: '../primary' },
    { ...snapshot, name: 42 },
    { ...snapshot, name: ' ' },
    { ...snapshot, createdAtMs: -1 },
    { ...snapshot, createdAtMs: 0.5 },
    { ...snapshot, createdAtMs: WORKFLOW_MAX_TIMESTAMP_MS + 1 },
    { ...snapshot, adjustmentXmp: { xml } },
    { ...snapshot, adjustmentXmp: 'x'.repeat(WORKFLOW_MAX_BYTES + 1) },
  ];
  for (const payload of malformed) {
    const response = await actionRequest('snapshot', 'primary', {
      expectedXmp: xml,
      snapshot: payload,
    });
    expect(response.status).toBe(422);
    expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
    expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
  }
});

test('API uses real Rust and atomic sidecar files while preserving authored WB/checkpoints', async () => {
  const response = await patch(corpus[0]);
  expect(response.status).toBe(200);
  const output = await readFile(join(directory, 'photo.xmp'), 'utf8');
  expect(output).toBe(await response.text());
  const read = await callNative('workflowReadXmp', [output]);
  expect(read.ok).toBe(true);
  if (!read.ok) throw Error(read.error);
  expect(JSON.parse(read.value)).toEqual(corpus[0]);
  expect(output).toContain('<crs:MaskGroupBasedCorrections>');
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
  // A client with an older model must not erase newly persisted workflow data.
  expect((await post(xml)).status).toBe(200);
  const retained = await callNative('workflowReadXmp', [
    await readFile(join(directory, 'photo.xmp'), 'utf8'),
  ]);
  expect(retained).toEqual(read);
  expect(
    (await writeXmpWithPrecondition(join(directory, 'photo.dng'), xml, null, 'workflow-test')).kind,
  ).toBe('ok');
  expect(
    await callNative('workflowReadXmp', [await readFile(join(directory, 'photo.xmp'), 'utf8')]),
  ).toEqual(read);
});
test('future/malformed records leave the exact on-disk sidecar and original untouched', async () => {
  expect((await patch(corpus[0])).status).toBe(200);
  const future = (await readFile(join(directory, 'photo.xmp'), 'utf8')).replace(
    '<papp:SchemaVersion>1',
    '<papp:SchemaVersion>2',
  );
  await writeFile(join(directory, 'photo.xmp'), future);
  expect((await patch(corpus[1])).status).toBe(422);
  expect((await post(xml)).status).toBe(500);
  expect(
    (await writeXmpWithPrecondition(join(directory, 'photo.dng'), xml, null, 'workflow-test')).kind,
  ).toBe('error');
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(future);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
test('invalid checkpoint and outside-root requests cannot publish', async () => {
  const invalid = {
    ...corpus[0],
    snapshots: [{ ...corpus[0].snapshots[0], adjustmentXmp: '<bad/>' }],
  };
  expect((await patch(invalid)).status).toBe(422);
  const denied = await app.handle(
    new Request('http://localhost/api/xmp/workflow?path=/outside/photo.dng', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpus[0]),
    }),
  );
  expect(denied.status).toBe(403);
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
});

test('API creates a workflow sidecar when none exists without touching the original', async () => {
  await unlink(join(directory, 'photo.xmp'));
  const response = await patch(corpus[0]);
  expect(response.status).toBe(200);
  const output = await readFile(join(directory, 'photo.xmp'), 'utf8');
  const read = await callNative('workflowReadXmp', [output]);
  expect(read.ok).toBe(true);
  if (!read.ok) throw Error(read.error);
  expect(JSON.parse(read.value)).toEqual(corpus[0]);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

const variantRequest = (route: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) => {
  const url = `http://localhost/api/xmp/${route}`;
  const request =
    method === 'GET'
      ? new Request(url)
      : new Request(url, {
          method: method === 'POST' ? 'POST' : 'PUT',
          headers: { 'Content-Type': method === 'POST' ? 'application/json' : 'application/xml' },
          body: method === 'POST' ? JSON.stringify(body) : String(body),
        });
  return app.handle(request);
};
const variantQuery = () => 'path=' + encodeURIComponent(join(directory, 'photo.dng'));

test('wired API creates portable siblings, reopens and saves one identity without changing others', async () => {
  const first = corpus[1];
  const route = 'variants?' + variantQuery();
  const results = await Promise.all([
    variantRequest(route, 'POST', first),
    variantRequest(route, 'POST', first),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  const selected = 'variant?' + variantQuery() + '&variantId=' + first.variantId;
  const edited = xml.replace(
    'crs:ProcessVersion="15.4"',
    'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
  );
  const written = await variantRequest(selected, 'PUT', edited);
  expect(written.status).toBe(200);
  const output = await written.text();
  expect(output).toContain('crs:Exposure2012="1.25"');
  const record = await callNative('workflowReadXmp', [output]);
  expect(record.ok).toBe(true);
  if (!record.ok) throw Error(record.error);
  expect(JSON.parse(record.value)).toEqual(first);
  const second = {
    ...first,
    variantId: crypto.randomUUID(),
    variantName: 'Alternate',
    snapshots: [],
    history: [],
  };
  expect(
    (await variantRequest(route + '&sourceVariantId=' + first.variantId, 'POST', second)).status,
  ).toBe(201);
  const reopened = await variantRequest(
    'variant?' + variantQuery() + '&variantId=' + second.variantId,
    'GET',
  );
  expect(reopened.status).toBe(200);
  expect(await reopened.text()).toContain('crs:Exposure2012="1.25"');
  const list = await (await variantRequest(route, 'GET')).json();
  expect(list.map((item: { variantId: string }) => item.variantId).sort()).toEqual(
    ['primary', first.variantId, second.variantId].sort(),
  );
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

test('missing, future and mismatched selected variants reject without fallback or publication', async () => {
  const route = 'variants?' + variantQuery();
  const missing = 'variant?' + variantQuery() + '&variantId=' + crypto.randomUUID();
  expect((await variantRequest(missing, 'GET')).status).toBe(404);
  expect((await variantRequest(missing, 'PUT', xml)).status).toBe(404);
  const first = corpus[1];
  expect((await variantRequest(route, 'POST', first)).status).toBe(201);
  const filename = join(directory, `photo.v${first.variantId}.xmp`);
  const saved = await readFile(filename, 'utf8');
  const future = saved.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2');
  await writeFile(filename, future);
  const selected = 'variant?' + variantQuery() + '&variantId=' + first.variantId;
  expect((await variantRequest(selected, 'PUT', xml)).status).toBe(422);
  expect((await variantRequest(route, 'GET')).status).toBe(422);
  expect(await readFile(filename, 'utf8')).toBe(future);
  const mismatch = saved.replace(first.variantId, crypto.randomUUID());
  await writeFile(filename, mismatch);
  expect((await variantRequest(selected, 'GET')).status).toBe(422);
  expect(await readFile(filename, 'utf8')).toBe(mismatch);
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
});

test('variant API requires committed source and authorized paths and rejects primary creation', async () => {
  const route = 'variants?' + variantQuery();
  expect((await variantRequest(route, 'POST', corpus[0])).status).toBe(409);
  await unlink(join(directory, 'photo.xmp'));
  expect((await variantRequest(route, 'POST', corpus[1])).status).toBe(409);
  expect(
    (await variantRequest(route, 'POST', { ...corpus[1], variantId: '../primary' })).status,
  ).toBe(422);
  expect((await variantRequest('variants?path=/outside/photo.dng', 'GET')).status).toBe(403);
  expect(
    (await variantRequest('variant?' + variantQuery() + '&variantId=../primary', 'PUT', xml))
      .status,
  ).toBe(422);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

for (const [route, method, body] of [
  ['variants', 'GET', undefined],
  ['variant', 'GET', undefined],
  ['variants', 'POST', corpus[1]],
  ['variant', 'PUT', xml],
] as const) {
  test(`${method} ${route} rejects malformed, outside-root and symlink-escape paths`, async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'maple-workflow-outside-')));
    try {
      const original = join(outside, 'photo.dng');
      const primary = join(outside, 'photo.xmp');
      const sibling = join(outside, `photo.v${corpus[1].variantId}.xmp`);
      await writeFile(original, new Uint8Array([44, 55, 66]));
      await writeFile(primary, xml);
      await writeFile(sibling, xml);
      await symlink(outside, join(directory, 'escape'), 'dir');
      const cases = [
        { path: original, status: 403 },
        { path: join(directory, 'escape', 'photo.dng'), status: 403 },
        { path: '../photo.dng', status: 400 },
        { path: '/photo%00.dng', status: 400 },
        { path: '/photo%FF.dng', status: 400 },
      ];
      for (const denied of cases) {
        const response = await variantRequest(
          route + '?path=' + encodeURIComponent(denied.path) + '&variantId=' + corpus[1].variantId,
          method,
          body,
        );
        expect(response.status).toBe(denied.status);
        expect((await response.json()).error).toBeString();
      }
      expect(await readFile(original)).toEqual(Buffer.from([44, 55, 66]));
      expect(await readFile(primary, 'utf8')).toBe(xml);
      expect(await readFile(sibling, 'utf8')).toBe(xml);
      expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
}

const actionRequest = (
  operation: string,
  variantId: string,
  body: unknown,
  rawPath = join(directory, 'photo.dng'),
) =>
  variantRequest(
    'variant/' + operation + '?path=' + encodeURIComponent(rawPath) + '&variantId=' + variantId,
    'POST',
    body,
  );
const historyEntry = (adjustmentXmp: string, action = 'adjustment') => ({
  id: crypto.randomUUID(),
  createdAtMs: 10,
  action,
  label: 'Committed action',
  adjustmentXmp,
});
const nativeValue = async (method: 'workflowCheckpointXmp' | 'workflowReadXmp', input: string) => {
  const result = await callNative(method, [input]);
  if (!result.ok) throw Error(result.error);
  return result.value;
};

test('the first snapshot creates its primary atomically with one winner and no invented history', async () => {
  await unlink(join(directory, 'photo.xmp'));
  const checkpoint = await nativeValue('workflowCheckpointXmp', xml);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      actionRequest('snapshot', 'primary', {
        expectedXmp: null,
        initialXmp: checkpoint,
        snapshot: {
          id: crypto.randomUUID(),
          name: `First snapshot ${index}`,
          createdAtMs: 1,
          adjustmentXmp: checkpoint,
        },
      }),
    ),
  );
  expect(attempts.filter((response) => response.status === 200)).toHaveLength(1);
  expect(attempts.filter((response) => response.status === 409)).toHaveLength(7);
  const saved = await readFile(join(directory, 'photo.xmp'), 'utf8');
  const record = JSON.parse(await nativeValue('workflowReadXmp', saved));
  expect(record.snapshots).toHaveLength(1);
  expect(record.history).toEqual([]);
  expect(await nativeValue('workflowCheckpointXmp', saved)).toBe(checkpoint);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
test('a rejected first snapshot cannot leave a partial initial sidecar behind', async () => {
  await unlink(join(directory, 'photo.xmp'));
  const snapshot = {
    id: crypto.randomUUID(),
    name: 'First snapshot',
    createdAtMs: 1,
    adjustmentXmp: xml,
  };
  const response = await actionRequest('snapshot', 'primary', {
    expectedXmp: null,
    initialXmp: '<bad/>',
    snapshot,
  });
  expect(response.status).toBe(422);
  await expect(readFile(join(directory, 'photo.xmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  const empty = await actionRequest('snapshot', 'primary', {
    expectedXmp: null,
    initialXmp: xml,
    snapshot: { ...snapshot, name: ' ' },
  });
  expect(empty.status).toBe(422);
  await expect(readFile(join(directory, 'photo.xmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});
test('confirmed selected-variant actions retain immutable snapshots and history through reopen', async () => {
  const branch = { ...corpus[1], snapshots: [], history: [] };
  expect((await variantRequest('variants?' + variantQuery(), 'POST', branch)).status).toBe(201);
  const filename = join(directory, `photo.v${branch.variantId}.xmp`);
  const initial = await readFile(filename, 'utf8');
  const checkpoint = await nativeValue('workflowCheckpointXmp', initial);
  const entry = historyEntry(checkpoint);
  const committed = await actionRequest('commit', branch.variantId, {
    expectedXmp: initial,
    xmp: initial,
    entry,
  });
  expect(committed.status).toBe(200);
  const saved = await committed.text();
  expect(await readFile(filename, 'utf8')).toBe(saved);
  const snapshot = {
    id: crypto.randomUUID(),
    name: 'Original treatment',
    createdAtMs: 11,
    adjustmentXmp: checkpoint,
  };
  const snap = await actionRequest('snapshot', branch.variantId, { expectedXmp: saved, snapshot });
  expect(snap.status).toBe(200);
  const snapped = await snap.text();
  const changed = checkpoint.replace(
    'crs:ProcessVersion="15.4"',
    'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
  );
  expect(changed).not.toBe(checkpoint);
  const adjustment = await actionRequest('commit', branch.variantId, {
    expectedXmp: snapped,
    xmp: changed,
    entry: historyEntry(changed),
  });
  expect(adjustment.status).toBe(200);
  const latest = await adjustment.text();
  const restore = await actionRequest('restore', branch.variantId, {
    expectedXmp: latest,
    entry: historyEntry(checkpoint, 'snapshot-restore'),
  });
  expect(restore.status).toBe(200);
  const restored = await restore.text();
  expect(await nativeValue('workflowCheckpointXmp', restored)).toBe(checkpoint);
  expect(await readFile(filename, 'utf8')).toBe(restored);
  const record = JSON.parse(await nativeValue('workflowReadXmp', restored));
  expect(record.variantId).toBe(branch.variantId);
  expect(record.snapshots).toEqual([snapshot]);
  expect(record.history.map((row: { action: string }) => row.action)).toEqual([
    'adjustment',
    'adjustment',
    'snapshot-restore',
  ]);
  const historyRestore = await actionRequest('restore', branch.variantId, {
    expectedXmp: restored,
    entry: historyEntry(changed, 'history-restore'),
  });
  expect(historyRestore.status).toBe(200);
  expect(await nativeValue('workflowCheckpointXmp', await historyRestore.text())).toBe(changed);
  expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

test('competing confirmed commits reject stale writers without dropping semantic history', async () => {
  await symlink(directory, join(directory, 'inside-alias'), 'dir');
  const first = historyEntry(xml);
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      actionRequest(
        'commit',
        'primary',
        {
          expectedXmp: xml,
          xmp: xml,
          entry: { ...first, id: crypto.randomUUID() },
        },
        index % 2 === 0
          ? join(directory, 'photo.dng')
          : join(directory, 'inside-alias', 'photo.dng'),
      ),
    ),
  );
  expect(outcomes.map((row) => row.status).sort()).toEqual([
    200, 409, 409, 409, 409, 409, 409, 409,
  ]);
  const saved = await readFile(join(directory, 'photo.xmp'), 'utf8');
  expect(JSON.parse(await nativeValue('workflowReadXmp', saved)).history).toHaveLength(1);
  const retry = await actionRequest('commit', 'primary', {
    expectedXmp: saved,
    xmp: xml,
    entry: historyEntry(xml),
  });
  expect(retry.status).toBe(200);
  expect(JSON.parse(await nativeValue('workflowReadXmp', await retry.text())).history).toHaveLength(
    2,
  );
});

test('explicit primary absence creates only once, while missing named branches never fall back', async () => {
  await unlink(join(directory, 'photo.xmp'));
  const requests = await Promise.all(
    [0, 1].map(() =>
      actionRequest('commit', 'primary', {
        expectedXmp: null,
        xmp: xml,
        entry: historyEntry(xml),
      }),
    ),
  );
  expect(requests.map((row) => row.status).sort()).toEqual([200, 409]);
  expect(
    (
      await actionRequest('commit', crypto.randomUUID(), {
        expectedXmp: null,
        xmp: xml,
        entry: historyEntry(xml),
      })
    ).status,
  ).toBe(404);
  expect(await readFile(join(directory, 'photo.dng'))).toEqual(Buffer.from([1, 0, 255, 42]));
});

test('forged checkpoints and restore states cannot publish and a failed action does not poison the write chain', async () => {
  for (const [operation, body] of [
    ['commit', { expectedXmp: xml, xmp: xml, entry: historyEntry(xml.replace('15.4', '16.0')) }],
    [
      'snapshot',
      {
        expectedXmp: xml,
        snapshot: {
          id: crypto.randomUUID(),
          name: 'Forged',
          createdAtMs: 1,
          adjustmentXmp: xml.replace('15.4', '16.0'),
        },
      },
    ],
    ['restore', { expectedXmp: xml, entry: historyEntry(xml, 'snapshot-restore') }],
  ] as const) {
    expect((await actionRequest(operation, 'primary', body)).status).toBe(422);
    expect(await readFile(join(directory, 'photo.xmp'), 'utf8')).toBe(xml);
    expect((await actionRequest(operation, 'primary', body, '/outside/photo.dng')).status).toBe(
      403,
    );
  }
  expect(
    (
      await actionRequest('commit', 'primary', {
        expectedXmp: xml,
        xmp: xml,
        entry: historyEntry(xml),
      })
    ).status,
  ).toBe(200);
});
