import { describe, expect, it } from 'bun:test';
import { ALL_STAGE_NAMES, assertCompleteStageNames } from './stage-names.ts';
import { blankStagesSkeleton, stageManifest, stageRegistrations } from './manifest.ts';

describe('canonical stage registrations', () => {
  it('pairs every definition with a starter under its own canonical name', () => {
    expect(Object.keys(stageRegistrations)).toEqual([...ALL_STAGE_NAMES]);
    expect(stageManifest.map((stage) => stage.name)).toEqual([...ALL_STAGE_NAMES]);
    expect(Object.keys(blankStagesSkeleton())).toEqual([...ALL_STAGE_NAMES]);
    for (const name of ALL_STAGE_NAMES) {
      expect(stageRegistrations[name].definition.name).toBe(name);
      expect(stageRegistrations[name].start).toBeFunction();
    }
  });

  it('fails when a registration is omitted instead of silently dropping a worker', () => {
    const missing = stageManifest.filter((stage) => stage.name !== 'sidecar-metadata-index');
    expect(() => assertCompleteStageNames(missing.map((stage) => stage.name))).toThrow(
      'missing [sidecar-metadata-index]',
    );
  });

  it('rejects duplicate or unknown registrations', () => {
    expect(() => assertCompleteStageNames([...ALL_STAGE_NAMES, 'exif'])).toThrow('duplicates 1');
    expect(() => assertCompleteStageNames([...ALL_STAGE_NAMES, 'unregistered'])).toThrow(
      'unknown [unregistered]',
    );
  });
});
