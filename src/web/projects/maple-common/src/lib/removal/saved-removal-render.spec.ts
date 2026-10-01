import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  initSync,
  NativeDetailSession,
  removal_content_digest,
  removal_prepare,
  render_bytes_sized,
} from '../raw-pipeline/pkg/raw_wasm';
import { bundleRemovalCompanions } from './removal-companion-bundle';

const root = resolve(process.cwd(), '../../test-fixtures/removal/basic');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(root, name)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const xmpFor = (records: string, exposure = 0) =>
  `<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:Exposure2012="${exposure}" papp:InpaintRemovals="${records.replaceAll('"', '&quot;')}"/>`;

// Actual release WASM, real RAW and companion codecs; no inference dependency.
describe('saved-removal rendering through retained RAW WASM bindings', () => {
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );

  const prepare = (session: NativeDetailSession) => {
    const request: unknown = JSON.parse(text('request.txt'));
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new Error('Invalid request fixture');
    }
    // Explicit calibrated test pixels. The legacy fixture decode identity is
    // replaced by the actual retained decoder anchor; no old edit is migrated.
    const records = removal_prepare(
      JSON.stringify({
        ...request,
        plate: 'linear-calibration-v1',
        source: JSON.parse(session.removal_calibration_source()) as unknown,
      }),
      '[]',
      fixture('mask.mimf'),
      fixture('patch.f16'),
    );
    const companions = new Map(
      ['mask.mimf', 'patch.f16'].map((name) => {
        const bytes = fixture(name);
        const suffix = name === 'mask.mimf' ? '.mask' : '.f16';
        return [removal_content_digest(bytes).slice('blake3:'.length) + suffix, bytes] as const;
      }),
    );
    const bundle = bundleRemovalCompanions(companions);
    const xmp = xmpFor(records);
    expect(session.prepare_saved_removals(xmp, bundle.manifest, bundle.bytes)).toBe('[]');
    return { xmp, bundle, records };
  };

  it('inspects and exports accepted pixels at native and viewport sizes after reopening', () => {
    const raw = fixture('source.dng');
    const before = raw.slice();
    const session = new NativeDetailSession(raw, 'dng');
    try {
      const { records, bundle } = prepare(session);
      for (const cap of [0, 4, 64]) {
        const xmp = xmpFor(records, 1);
        const patch = session.render_saved_removals(xmp, cap, new Uint8Array());
        try {
          const rgb = patch.take_rgb();
          expect(rgb.length).toBe(patch.width * patch.height * 3);
          const result = session.export_saved_removals(
            xmp,
            JSON.stringify({
              format: 'png',
              quality: 100,
              color_space: 'srgb',
              max_long_edge: cap,
            }),
            new Uint8Array(),
          );
          try {
            expect([result.width, result.height]).toEqual([patch.width, patch.height]);
            expect([...result.chunk(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
            const bytes = result.chunk(0, result.byteLength);
            expect(bytes.byteLength).toBe(result.byteLength);
          } finally {
            result.free();
          }
        } finally {
          patch.free();
        }
      }
      const reopened = new NativeDetailSession(raw, 'dng');
      try {
        const xmp = xmpFor(records);
        reopened.prepare_saved_removals(xmp, bundle.manifest, bundle.bytes);
        const saved = reopened.render_saved_removals(xmp, 4, new Uint8Array());
        const ordinary = render_bytes_sized(raw, 'dng', xmpFor('[]'), false, 4);
        try {
          expect(saved.take_rgb()).not.toEqual(ordinary.take_rgb());
        } finally {
          saved.free();
          ordinary.free();
        }
      } finally {
        reopened.free();
      }
      expect(raw).toEqual(before);
    } finally {
      session.free();
    }
  });

  it('clears old prepared pixels when any companion fails and rejects changed records', () => {
    const session = new NativeDetailSession(fixture('source.dng'), 'dng');
    try {
      const { xmp, bundle } = prepare(session);
      expect(() => session.render_saved_removals(xmpFor('[]'), 4, new Uint8Array())).toThrow(
        'stack changed',
      );
      const corrupt = bundle.bytes.slice();
      corrupt[0] ^= 1;
      expect(() => session.prepare_saved_removals(xmp, bundle.manifest, corrupt)).toThrow();
      expect(() => session.render_saved_removals(xmp, 4, new Uint8Array())).toThrow(
        'not been prepared',
      );
      expect(() =>
        session.export_saved_removals(
          xmp,
          JSON.stringify({
            format: 'png',
            quality: 100,
            color_space: 'srgb',
            max_long_edge: 4,
          }),
          new Uint8Array(),
        ),
      ).toThrow('not been prepared');
    } finally {
      session.free();
    }
  });
});
