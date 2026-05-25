import { describe, it, expect } from 'bun:test';
import { FACE_STAGE_NAMES } from './face-bootstrap.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';

/**
 * The face enrichment toggle pauses/unpauses the face pipeline via the
 * worker_config stage keys. The monolithic `face` stage was split into
 * `face-detect` + `face-embed`; the toggle must cover BOTH stage keys, not
 * the retired `face` key, or the split pipeline becomes uncontrollable from
 * the UI. These pure assertions guard against the list drifting out of sync
 * with the manifest (no Mongo / ONNX needed).
 */
describe('FACE_STAGE_NAMES', () => {
  it('targets both split stages, not the legacy `face` key', () => {
    expect([...FACE_STAGE_NAMES]).toEqual(['face-detect', 'face-embed']);
    expect(FACE_STAGE_NAMES).not.toContain('face');
  });

  it('only lists stage names that exist in the manifest', () => {
    for (const name of FACE_STAGE_NAMES) {
      expect(ALL_STAGE_NAMES as readonly string[]).toContain(name);
    }
  });

  it('covers every face-* stage the manifest declares', () => {
    const manifestFaceStages = [...ALL_STAGE_NAMES].filter((n) => n.startsWith('face')).sort();
    const declared: string[] = [...FACE_STAGE_NAMES].sort();
    expect(declared).toEqual(manifestFaceStages);
  });
});
