import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
      expect(
        napi.workflowValidateJson(json.replace('"schemaVersion":1', '"schemaVersion":2')).ok,
      ).toBe(false);
    }
  },
);
