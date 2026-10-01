import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, NativeDetailSession, removal_selection } from './pkg/raw_wasm';
import { NativeDetailWorker } from './raw-pipeline.native-detail-handler';
import { runRemovalAuthoring } from './raw-pipeline.removal-handler';
import { bundleRemovalCompanions } from '../removal/removal-companion-bundle';
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
      const fixture = resolve(process.cwd(), '../../test-fixtures/removal/calibration');
      const savedXmp = readFileSync(resolve(fixture, 'saved.xmp'), 'utf8');
      const records = JSON.parse(readFileSync(resolve(fixture, 'records.txt'), 'utf8')) as {
        accepted: { mask: string };
        patch: string;
      }[];
      const bundle = bundleRemovalCompanions(
        new Map([
          [
            records[0].accepted.mask.slice(7) + '.mask',
            new Uint8Array(readFileSync(resolve(fixture, 'mask.mimf'))),
          ],
          [
            records[0].patch.slice(7) + '.f16',
            new Uint8Array(readFileSync(resolve(fixture, 'patch.f16'))),
          ],
        ]),
      );
      const installed = await call(
        request(
          {
            kind: 'prepare-saved',
            xmp: savedXmp,
            manifest: bundle.manifest,
            companions: bundle.bytes.buffer,
          },
          anchor.original,
        ),
      );
      expect(installed).toEqual({ kind: 'prepared', review: '[]' });
      const rendered = await call(
        request({ kind: 'render-saved', xmp: savedXmp, cap: 4 }, anchor.original),
      );
      if (rendered.kind !== 'rendered') throw Error('Unexpected saved preview reply');
      const expected = new NativeDetailSession(raw, 'dng');
      expected.prepare_saved_removals(savedXmp, bundle.manifest, bundle.bytes);
      const image = expected.render_saved_preview(savedXmp, 4, new Uint8Array());
      try {
        expect(new Uint8Array(rendered.frame.rgb)).toEqual(image.take_rgb());
        expect([rendered.frame.nativeWidth, rendered.frame.nativeHeight]).toEqual([
          image.full_width,
          image.full_height,
        ]);
        expect(rendered.frame.asShotTemperature).toBe(image.as_shot_temperature);
        expect(rendered.frame.asShotTint).toBe(image.as_shot_tint);
      } finally {
        image.free();
        expected.free();
      }
      const savedContext = await call(
        request(
          {
            kind: 'generation-context',
            xmp: savedXmp,
            rect: [1, 1, 7, 5],
            manifest: bundle.manifest,
            companions: bundle.bytes.buffer,
          },
          anchor.original,
        ),
      );
      if (savedContext.kind !== 'context') throw Error('Unexpected generation context reply');
      const before = new Float32Array(context.rgb),
        after = new Float32Array(savedContext.rgb);
      expect(after).toHaveLength(before.length);
      expect(after.some((value, index) => value !== before[index])).toBe(true);
      const corrupt = bundle.bytes.slice();
      corrupt[0] ^= 1;
      await expect(
        call(
          request(
            {
              kind: 'generation-context',
              xmp: savedXmp,
              rect: [1, 1, 7, 5],
              manifest: bundle.manifest,
              companions: corrupt.buffer,
            },
            anchor.original,
          ),
        ),
      ).rejects.toThrow();
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
