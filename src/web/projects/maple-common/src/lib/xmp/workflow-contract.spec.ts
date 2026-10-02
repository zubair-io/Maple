import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSidecarWorkflow, WORKFLOW_HISTORY_LIMIT } from '../generated/workflow.generated';

const corpus = JSON.parse(
  readFileSync(resolve('../../test-fixtures/workflow/contract-v1.json'), 'utf8'),
);
describe('shared workflow wire contract (#4035)', () => {
  it('reopens complete checkpoint XMP without changing any bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maple-workflow-web-'));
    try {
      for (const record of corpus) {
        const workflow = parseSidecarWorkflow(record);
        const path = join(directory, `${workflow.variantId}.json`);
        writeFileSync(path, JSON.stringify(workflow));
        expect(parseSidecarWorkflow(JSON.parse(readFileSync(path, 'utf8')))).toEqual(record);
        for (const checkpoint of [...workflow.snapshots, ...workflow.history]) {
          const xmp = join(directory, `${checkpoint.id}.xmp`);
          writeFileSync(xmp, checkpoint.adjustmentXmp);
          expect(readFileSync(xmp, 'utf8')).toBe(checkpoint.adjustmentXmp);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects malformed records without mutating incoming state', () => {
    const value = corpus[0];
    const before = JSON.stringify(value);
    const { variantName: _name, ...missing } = value;
    const { adjustmentXmp: _xmp, ...missingCheckpoint } = value.snapshots[0];
    for (const invalid of [
      { ...value, schemaVersion: 2 },
      missing,
      { ...value, future: true },
      { ...value, snapshots: [{ ...value.snapshots[0], future: true }] },
      { ...value, snapshots: [missingCheckpoint] },
      { ...value, variantId: '../photo' },
      { ...value, variantName: '\n' },
      { ...value, snapshots: [value.snapshots[0], value.snapshots[0]] },
      { ...value, history: [value.history[0], value.history[0]] },
      { ...value, history: [{ ...value.history[0], action: 'render' }] },
      { ...value, history: [{ ...value.history[0], createdAtMs: 9007199254740992 }] },
      { ...value, snapshots: [{ ...value.snapshots[0], id: `${value.snapshots[0].id}\n` }] },
      {
        ...value,
        history: Array.from({ length: WORKFLOW_HISTORY_LIMIT + 1 }, (_, n) => ({
          ...value.history[0],
          id: `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`,
        })),
      },
    ])
      expect(() => parseSidecarWorkflow(invalid)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
    const parsed = parseSidecarWorkflow(value);
    expect(parsed).not.toBe(value);
    expect(parsed.snapshots).not.toBe(value.snapshots);
  });
});
