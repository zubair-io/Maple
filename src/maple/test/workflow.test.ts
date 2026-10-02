import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeAvailable, loadNativeBinding } from '../src/native';
import { resolvePlatformNapiAddon } from '../src/platform';
import { tryLoadNapiBinding } from '../src/native-napi';
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
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
          embedded.value.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2'),
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
        embedded.value.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2'),
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
          embedded.value.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2'),
        ).ok,
      ).toBe(false);
      expect(
        napi.workflowValidateJson(json.replace('"schemaVersion":1', '"schemaVersion":2')).ok,
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
            embedded.value.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2'),
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
