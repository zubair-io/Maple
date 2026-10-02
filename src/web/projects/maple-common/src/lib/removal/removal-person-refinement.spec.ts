import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  initSync,
  NativeDetailSession,
  removal_selection,
  removal_combine_masks,
} from '../raw-pipeline/pkg/raw_wasm';
import { runRemovalAuthoring } from '../raw-pipeline/raw-pipeline.removal-handler';
import type { RemovalAuthoringClient } from '../raw-pipeline/raw-pipeline.removal-client';
import { refinePeople, type PersonGesture } from './removal-person-refinement';

describe('native person-mask replay through actual retained RAW worker boundary', () => {
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );
  const circle = (x: number, y: number, radius = 0.07) =>
    removal_selection(
      16,
      8,
      JSON.stringify({ schema: 1, strokes: [{ points: [[x, y]], radius, subtract: false }] }),
    );
  it('preserves separate people and protection, supports cross-person undo and never invokes inference', async () => {
    const raw = new Uint8Array(
      readFileSync(resolve(process.cwd(), '../../test-fixtures/removal/basic/source.dng')),
    );
    const retained = new NativeDetailSession(raw, 'dng');
    const source = JSON.parse(retained.removal_calibration_source()) as { original: string };
    const client = {
      refineSelection: async (base: Uint8Array, request: string, protection: Uint8Array) => {
        const value = runRemovalAuthoring(retained, {
          id: 1,
          type: 'removal-authoring',
          sourceId: 'photo',
          ext: 'dng',
          original: source.original,
          command: {
            kind: 'refine-selection',
            request,
            base: base.slice().buffer,
            protection: protection.slice().buffer,
          },
        });
        if (value.kind !== 'selection') throw Error('Wrong refinement reply');
        return new Uint8Array(value.mask);
      },
    } as RemovalAuthoringClient;
    try {
      const left = circle(3.5 / 16, 3.5 / 8),
        right = circle(12.5 / 16, 3.5 / 8),
        protection = circle(7.5 / 16, 3.5 / 8);
      const bases = [
        { index: 0, mask: left },
        { index: 1, mask: right },
      ];
      const edits: PersonGesture[] = [
        { index: 0, strokes: [{ points: [[3.5 / 16, 6.5 / 8]], radius: 0.07, subtract: false }] },
        { index: 0, strokes: [{ points: [[7.5 / 16, 3.5 / 8]], radius: 0.07, subtract: false }] },
        { index: 1, strokes: [{ points: [[12.5 / 16, 3.5 / 8]], radius: 0.07, subtract: true }] },
      ];
      const initial = await refinePeople(bases, [], protection, client);
      const added = await refinePeople(bases, edits.slice(0, 1), protection, client);
      expect(added.selection).not.toEqual(initial.selection);
      expect(added.masks[1]).toEqual(right);
      const protectedResult = await refinePeople(bases, edits.slice(0, 2), protection, client);
      expect(removal_combine_masks(protectedResult.selection, protection, true)).toEqual(
        protectedResult.selection,
      );
      expect((await refinePeople(bases, edits, protection, client)).masks).toHaveLength(1);
      expect((await refinePeople(bases, edits.slice(0, 2), protection, client)).masks).toHaveLength(
        2,
      );
      expect((await refinePeople(bases, [], protection, client)).selection).toEqual(
        initial.selection,
      );
      await expect(
        client.refineSelection(new Uint8Array(), '{"schema":1,"strokes":[]}', protection),
      ).rejects.toThrow();
      const wrong = removal_selection(
        32,
        8,
        '{"schema":1,"strokes":[{"points":[[0.5,0.5]],"radius":0.1,"subtract":false}]}',
      );
      await expect(
        client.refineSelection(wrong, '{"schema":1,"strokes":[]}', protection),
      ).rejects.toThrow('geometry');
      await expect(
        client.refineSelection(left, '{"schema":1,"strokes":[]}', wrong),
      ).rejects.toThrow('geometry');
    } finally {
      retained.free();
    }
  });
});
