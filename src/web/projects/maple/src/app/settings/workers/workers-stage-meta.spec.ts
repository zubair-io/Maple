import { describe, expect, it } from 'vitest';
import { ALL_STAGE_NAMES } from '../../../../../../../api/src/workers/stages/stage-names';
import { STAGE_META, stageMeta } from './workers-stage-meta';

describe('worker stage display coverage', () => {
  it('supplies explicit metadata for every canonical server stage', () => {
    for (const name of ALL_STAGE_NAMES) {
      const meta = STAGE_META[name];
      expect(meta, name).toBeDefined();
      expect(meta.id).toBe(name);
      expect(meta.description.trim().length).toBeGreaterThan(0);
      expect(meta.icon).not.toBe('pipe');
    }
  });

  it('keeps the compatibility fallback for unknown stages', () => {
    expect(stageMeta('future-worker')).toEqual({
      id: 'future-worker',
      group: 'Ingest',
      icon: 'pipe',
      description: '',
      enrichment: null,
    });
  });
});
