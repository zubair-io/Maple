import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, NativeDetailSession, removal_selection } from './pkg/raw_wasm';
import { NativeDetailWorker } from './raw-pipeline.native-detail-handler';
import { runRemovalAuthoring } from './raw-pipeline.removal-handler';
import type { RemovalAuthoringRequest, RemovalRawSession } from './raw-pipeline.removal.types';

const raw = new Uint8Array(
  readFileSync(resolve(process.cwd(), '../../test-fixtures/removal/basic/source.dng')),
);
const request = (
  command: RemovalAuthoringRequest['command'],
  original?: string,
): RemovalAuthoringRequest => ({
  id: 1,
  type: 'removal-authoring',
  sourceId: 'real-raw',
  ext: 'dng',
  command,
  original,
});

describe('retained CPU RAW authoring worker', () => {
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );

  it('reuses actual decoded RAW for geometry, context and native paint and rejects a changed original', async () => {
    let opens = 0;
    const worker = new NativeDetailWorker({
      ready: async () => ({}),
      post: () => {},
      open: (bytes, ext) => {
        opens++;
        return new NativeDetailSession(bytes, ext);
      },
    });
    const call = (req: RemovalAuthoringRequest) =>
      worker.withRemovalSession(
        req.sourceId,
        req.ext,
        req.command.kind === 'source' ? req.command.bytes : undefined,
        (session) => runRemovalAuthoring(session as unknown as RemovalRawSession, req),
      );
    try {
      const source = await call(request({ kind: 'source', bytes: raw.slice().buffer }));
      if (source.kind !== 'source') throw Error('Unexpected source reply');
      const anchor = JSON.parse(source.source) as { original: string };
      const xmp =
        '<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>';
      const mapping = await call(
        request(
          { kind: 'map', xmp, request: '{"schema":1,"points":[[0,0.5],[0.8,0.5]]}' },
          anchor.original,
        ),
      );
      if (mapping.kind !== 'map') throw Error('Unexpected map reply');
      const mapped = JSON.parse(mapping.mapping) as { points: (number[] | null)[] };
      expect(mapped.points[0]).toBeNull();
      expect(mapped.points[1]?.[0]).toBeCloseTo(0.3, 7);
      const context = await call(request({ kind: 'context', rect: [1, 1, 7, 5] }, anchor.original));
      if (context.kind !== 'context') throw Error('Unexpected context reply');
      expect(new Float32Array(context.rgb)).toHaveLength(7 * 5 * 3);
      const strokes = JSON.stringify({
        schema: 1,
        strokes: [{ subtract: false, radius: 0.1, points: [[0.5, 0.5]] }],
      });
      const selection = await call(
        request({ kind: 'selection', request: strokes }, anchor.original),
      );
      if (selection.kind !== 'selection') throw Error('Unexpected selection reply');
      expect(new Uint8Array(selection.mask)).toEqual(removal_selection(16, 8, strokes));
      expect(opens).toBe(1);
      await expect(
        call(request({ kind: 'context', rect: [0, 0, 1, 1] }, 'blake3:' + 'f'.repeat(64))),
      ).rejects.toThrow('source changed');
      await expect(
        call(request({ kind: 'context', rect: [-1, 0, 1, 1] }, anchor.original)),
      ).rejects.toThrow('rectangle');
      worker.close();
      await expect(
        call(request({ kind: 'map', xmp, request: '{"schema":1,"points":[]}' }, anchor.original)),
      ).rejects.toThrow('session changed');
    } finally {
      worker.close();
    }
  });
});
