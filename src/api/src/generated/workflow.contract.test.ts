import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSidecarWorkflow } from './workflow.generated';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
);
describe('API workflow wire contract (#4035)', () => {
  test('real file round trips preserve every checkpoint byte', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maple-workflow-api-'));
    try {
      for (const record of corpus) {
        const workflow = parseSidecarWorkflow(record);
        const path = join(directory, `${workflow.variantId}.json`);
        writeFileSync(path, JSON.stringify(workflow));
        expect(parseSidecarWorkflow(JSON.parse(readFileSync(path, 'utf8')))).toEqual(record);
        for (const entry of [...workflow.snapshots, ...workflow.history]) {
          const sidecar = join(directory, `${entry.id}.xmp`);
          writeFileSync(sidecar, entry.adjustmentXmp);
          expect(readFileSync(sidecar, 'utf8')).toBe(entry.adjustmentXmp);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('rejects unsupported schema and malformed semantic records', () => {
    const value = corpus[0];
    const before = JSON.stringify(value);
    for (const invalid of [
      { ...value, schemaVersion: 2 },
      { ...value, future: true },
      { ...value, variantId: 'other.xmp' },
      { ...value, history: [value.history[0], value.history[0]] },
      { ...value, snapshots: [{ ...value.snapshots[0], future: true }] },
      { ...value, history: [{ ...value.history[0], action: 'cache' }] },
      { ...value, history: [{ ...value.history[0], createdAtMs: 9007199254740992 }] },
    ])
      expect(() => parseSidecarWorkflow(invalid)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
});
