import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeAvailable, loadNativeBinding } from '../src/native';
import { resolvePlatformNapiAddon } from '../src/platform';
import { tryLoadNapiBinding } from '../src/native-napi';
const corpus = JSON.parse(
  readFileSync(new URL('../../../test-fixtures/workflow/contract.json', import.meta.url), 'utf8'),
);
const xml = readFileSync(
  new URL('../../../test-fixtures/local-adjustments/lightroom-group-add.xmp', import.meta.url),
  'utf8',
);
test.skipIf(!isNativeAvailable())(
  'Bun workflow ABI returns the same records and rejects invalid complete checkpoints',
  () => {
    const binding = loadNativeBinding();
    for (const row of corpus) {
      const json = JSON.stringify(row);
      const embedded = binding.workflowEmbedXmp(json, xml);
      expect(embedded.ok).toBe(true);
      if (!embedded.ok) throw Error(embedded.error);
      const read = binding.workflowReadXmp(embedded.value);
      expect(read.ok).toBe(true);
      if (!read.ok) throw Error(read.error);
      expect(JSON.parse(read.value)).toEqual(row);
      expect(binding.workflowValidateJson(json)).toEqual(read);
      expect(
        binding.workflowReadXmp(
          embedded.value.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3'),
        ).ok,
      ).toBe(false);
      expect(binding.workflowEmbedXmp('{}', embedded.value).ok).toBe(false);
    }
    const row = corpus[1];
    const embedded = binding.workflowEmbedXmp(JSON.stringify(row), xml);
    if (!embedded.ok) throw Error(embedded.error);
    const checkpoint = binding.workflowCheckpointXmp(embedded.value);
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw Error(checkpoint.error);
    expect(binding.workflowReadXmp(checkpoint.value)).toEqual({ ok: true, value: 'null' });
    expect(checkpoint.value).toContain('<crs:MaskGroupBasedCorrections>');
    expect(binding.workflowCheckpointXmp(xml)).toEqual({ ok: true, value: xml });
    expect(
      binding.workflowCheckpointXmp(
        embedded.value.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3'),
      ).ok,
    ).toBe(false);
    expect(binding.workflowVariantFilename('photo.MOV.xmp', row.variantId)).toEqual({
      ok: true,
      value: `photo.MOV.v${row.variantId}.xmp`,
    });
    expect(binding.workflowVariantFilename('photo.MOV.xmp', 'primary')).toEqual({
      ok: true,
      value: 'photo.MOV.xmp',
    });
    expect(binding.workflowVariantFilename('../photo.xmp', row.variantId).ok).toBe(false);
    expect(binding.workflowVariantFilename('photo.xmp', '../primary').ok).toBe(false);
    expect(binding.workflowReadXmp(xml)).toEqual({ ok: true, value: 'null' });
    expect(binding.workflowReadXmp('').ok).toBe(false);
  },
);
test.skipIf(!resolvePlatformNapiAddon())(
  'built N-API addon exactly matches Bun conversion and rejection outcomes',
  () => {
    const napi = tryLoadNapiBinding();
    if (!napi) throw Error('Build raw-napi before the workflow binding qualification');
    const ffi = loadNativeBinding();
    for (const row of corpus) {
      const json = JSON.stringify(row);
      expect(napi.workflowEmbedXmp(json, xml)).toEqual(ffi.workflowEmbedXmp(json, xml));
      expect(napi.workflowValidateJson(json)).toEqual(ffi.workflowValidateJson(json));
      const embedded = ffi.workflowEmbedXmp(json, xml);
      if (!embedded.ok) throw Error(embedded.error);
      expect(napi.workflowCheckpointXmp(embedded.value)).toEqual(
        ffi.workflowCheckpointXmp(embedded.value),
      );
      expect(napi.workflowVariantFilename('photo.MOV.xmp', row.variantId)).toEqual(
        ffi.workflowVariantFilename('photo.MOV.xmp', row.variantId),
      );
      expect(napi.workflowVariantFilename('../photo.xmp', row.variantId).ok).toBe(false);
      expect(
        napi.workflowCheckpointXmp(
          embedded.value.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3'),
        ).ok,
      ).toBe(false);
      expect(
        napi.workflowValidateJson(json.replace('"schemaVersion":2', '"schemaVersion":3')).ok,
      ).toBe(false);
    }
  },
);

test.skipIf(!isNativeAvailable() || !resolvePlatformNapiAddon())(
  'real Bun and N-API checkpoint bytes survive sibling files without touching originals',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'maple-variant-bindings-'));
    try {
      const original = Buffer.from([1, 0, 255, 42]);
      const raw = join(directory, 'photo.MOV');
      writeFileSync(raw, original);
      const ffi = loadNativeBinding();
      const napi = tryLoadNapiBinding();
      if (!napi) throw Error('Build raw-napi before native checkpoint qualification');
      const row = corpus[1];
      const embedded = ffi.workflowEmbedXmp(JSON.stringify(row), xml);
      if (!embedded.ok) throw Error(embedded.error);
      const start = embedded.value.indexOf('<papp:Workflow');
      const end = embedded.value.indexOf('</papp:Workflow>') + '</papp:Workflow>'.length;
      const expected = embedded.value.slice(0, start) + embedded.value.slice(end);
      for (const binding of [ffi, napi]) {
        const name = binding.workflowVariantFilename('photo.MOV.xmp', row.variantId);
        const checkpoint = binding.workflowCheckpointXmp(embedded.value);
        if (!name.ok) throw Error(name.error);
        if (!checkpoint.ok) throw Error(checkpoint.error);
        const sidecar = join(directory, name.value);
        writeFileSync(sidecar, checkpoint.value, 'utf8');
        expect(readFileSync(sidecar)).toEqual(Buffer.from(expected, 'utf8'));
        expect(binding.workflowReadXmp(readFileSync(sidecar, 'utf8'))).toEqual({
          ok: true,
          value: 'null',
        });
        expect(
          binding.workflowCheckpointXmp(
            embedded.value.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3'),
          ).ok,
        ).toBe(false);
        expect(readFileSync(sidecar)).toEqual(Buffer.from(expected, 'utf8'));
        expect(readFileSync(raw)).toEqual(original);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('real FFI and N-API commit/snapshot/restore persist exact checkpoints and reject stale mutations', () => {
  const ffi = loadNativeBinding();
  const napi = tryLoadNapiBinding();
  if (!napi) throw Error('Build raw-napi before authoring mutation qualification');
  for (const binding of [ffi, napi]) {
    const dir = mkdtempSync(join(tmpdir(), 'maple-workflow-actions-'));
    const original = join(dir, 'photo.dng');
    const sidecar = join(dir, 'photo.xmp');
    const value = (result: ReturnType<typeof binding.workflowReadXmp>) => {
      if (!result.ok) throw Error(result.error);
      return result.value;
    };
    const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
    const entry = (xmp: string, n: number, action = 'adjustment') => ({
      id: id(n),
      createdAtMs: n,
      action,
      label: 'Committed exposure',
      adjustmentXmp: value(binding.workflowCheckpointXmp(xmp)),
    });
    try {
      writeFileSync(original, new Uint8Array([1, 0, 255, 42]));
      const first = value(binding.workflowCommitXmp(xml, JSON.stringify(entry(xml, 1))));
      const captured = value(binding.workflowCheckpointXmp(first));
      const snapshot = {
        id: id(100),
        name: 'Warm study 🌅',
        createdAtMs: 1,
        adjustmentXmp: captured,
      };
      const saved = value(binding.workflowSnapshotXmp(first, JSON.stringify(snapshot)));
      const edited = saved.replace(
        'crs:ProcessVersion="15.4"',
        'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
      );
      const next = value(binding.workflowCommitXmp(edited, JSON.stringify(entry(edited, 2))));
      writeFileSync(sidecar, next);
      const reopened = readFileSync(sidecar, 'utf8');
      const restore = entry(captured, 3, 'snapshot-restore');
      const restored = value(binding.workflowRestoreXmp(reopened, JSON.stringify(restore)));
      const record = JSON.parse(value(binding.workflowReadXmp(restored)));
      expect(record.snapshots).toEqual([snapshot]);
      expect(record.history.at(-1)).toEqual({ ...restore, parentId: '', writer: '' });
      expect(value(binding.workflowCheckpointXmp(restored))).toBe(captured);
      expect(binding.workflowCommitXmp(edited, JSON.stringify(entry(saved, 4))).ok).toBe(false);
      expect(binding.workflowSnapshotXmp(saved, JSON.stringify(snapshot)).ok).toBe(false);
      expect(
        binding.workflowRestoreXmp(next, JSON.stringify(entry(edited, 4, 'snapshot-restore'))).ok,
      ).toBe(false);
      expect(
        binding.workflowCommitXmp(
          next.replace('<papp:SchemaVersion>2', '<papp:SchemaVersion>3'),
          JSON.stringify(entry(edited, 4)),
        ).ok,
      ).toBe(false);
      expect(readFileSync(sidecar, 'utf8')).toBe(next);
      expect(readFileSync(original)).toEqual(Buffer.from([1, 0, 255, 42]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('real FFI and N-API reconcile a stale writer, keep both edits and derive the undo stacks', () => {
  const ffi = loadNativeBinding();
  const napi = tryLoadNapiBinding();
  if (!napi) throw Error('Build raw-napi before reconcile qualification');
  const withAttribute = (doc: string, name: string, value: string) =>
    doc.replace('crs:ProcessVersion="15.4"', `crs:ProcessVersion="15.4" ${name}="${value}"`);
  const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
  for (const binding of [ffi, napi]) {
    const value = (result: ReturnType<typeof binding.workflowReadXmp>) => {
      if (!result.ok) throw Error(result.error);
      return result.value;
    };
    const entry = (doc: string, n: number, parentId: string, writer: string) => ({
      id: id(n),
      createdAtMs: n,
      action: 'adjustment',
      label: `Edit ${n}`,
      parentId,
      writer,
      adjustmentXmp: value(binding.workflowCheckpointXmp(doc)),
    });
    const commit = (doc: string, row: ReturnType<typeof entry>) =>
      value(binding.workflowCommitXmp(doc, JSON.stringify(row)));

    const base = commit(xml, entry(xml, 1, '', 'apple'));
    // Writer A publishes from the base; writer B, still on the base, reconciles.
    const editedByA = withAttribute(base, 'crs:Exposure2012', '1.25');
    const a = commit(editedByA, entry(editedByA, 2, id(1), 'apple'));
    const incoming = withAttribute(base, 'crs:Contrast2012', '30');
    const merged = value(binding.workflowReconcileXmp(base, a, incoming, '1790000000000'));
    const b = commit(merged, entry(merged, 3, id(1), 'web'));

    const record = JSON.parse(value(binding.workflowReadXmp(b)));
    expect(record.history.map((row: { id: string }) => row.id)).toEqual([id(1), id(2), id(3)]);
    expect(record.history[2]).toMatchObject({ parentId: id(1), writer: 'web' });
    expect(b).toContain('crs:Exposure2012="1.25"');
    expect(b).toContain('crs:Contrast2012="30"');
    expect(JSON.parse(value(binding.workflowCursorXmp(b)))).toEqual({
      undo: [id(1), id(2)],
      redo: [],
      synced: true,
    });
    // An outside edit becomes an `external` entry and the next undo step.
    const outside = withAttribute(b, 'crs:Tint', '10');
    const captured = value(
      binding.workflowReconcileXmp(
        b,
        outside,
        withAttribute(b, 'crs:Highlights2012', '-5'),
        '1790000000001',
      ),
    );
    expect(JSON.parse(value(binding.workflowReadXmp(captured))).history.at(-1)).toMatchObject({
      action: 'external',
      writer: '',
    });
    for (const now of ['-1', 'abc', '1.5', '9007199254740992']) {
      expect(binding.workflowReconcileXmp(base, a, incoming, now).ok).toBe(false);
    }
    expect(binding.workflowReconcileXmp('not xml', a, incoming, '1').ok).toBe(false);
  }
});
