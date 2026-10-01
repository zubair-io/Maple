import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, render_bytes_sized } from '../raw-pipeline/pkg/raw_wasm';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import { hydratePartialWhiteBalance } from '../models/partial-white-balance';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const parser = new XmpParserService();
const serializer = new XmpSerializerService();
const neutral = (): AdjustmentModel => ({ ...defaultAdjustmentModel(), profile: 'Neutral' });
function sidecar(axis: string, version: number): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Custom" papp:Profile="Neutral" papp:WbScaleVersion="${version}" ${axis}/></rdf:RDF></x:xmpmeta>`;
}
function render(bytes: Uint8Array, xml: string) {
  const image = render_bytes_sized(bytes, 'dng', xml, false, 1024);
  try {
    return {
      rgb: image.take_rgb(),
      temperature: image.as_shot_temperature,
      tint: image.as_shot_tint,
    };
  } finally {
    image.free();
  }
}

describe('partial white balance through the actual WASM develop (#3434)', () => {
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );
  for (const name of ['source', 'target']) {
    for (const version of [1, 2, 3, 4, 5]) {
      it(`${name} V${version}: parse, hydrate and unrelated real sidecar save preserve core pixels`, () => {
        const bytes = new Uint8Array(
          readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer', name + '.dng')),
        );
        const camera = render(bytes, serializer.serialize(neutral()));
        expect(Math.abs(camera.tint)).toBeGreaterThan(0.5);
        const directory = mkdtempSync(join(tmpdir(), 'maple-wasm-wb-'));
        try {
          const path = join(directory, 'photo.xmp');
          for (const axis of [
            'crs:Temperature="8500"',
            'crs:Tint="40"',
            'crs:Temperature="6500"',
            'crs:Tint="0"',
          ]) {
            writeFileSync(path, sidecar(axis, version));
            const sourceXml = readFileSync(path, 'utf8');
            const original = render(bytes, sourceXml);
            const imported = { ...neutral(), ...parser.parseAdjustmentModel(sourceXml).model };
            const hydrated = hydratePartialWhiteBalance(
              imported,
              camera.temperature,
              camera.tint,
              true,
            );
            writeFileSync(path, serializer.serialize(hydrated));
            const saved = readFileSync(path, 'utf8');
            expect([...render(bytes, saved).rgb]).toEqual([...original.rgb]);
            const unrelated = { ...hydrated, exposure: 1.25 };
            writeFileSync(path, serializer.serialize(unrelated));
            const edited = readFileSync(path, 'utf8');
            expect(edited).not.toContain(
              axis.includes('Temperature') ? 'crs:Tint=' : 'crs:Temperature=',
            );
            const independentEdit = sourceXml.replace(
              '/></rdf:RDF>',
              ' crs:Exposure2012="1.25"/></rdf:RDF>',
            );
            expect([...render(bytes, edited).rgb]).toEqual([...render(bytes, independentEdit).rgb]);
            if (version === 5) {
              const authored: AdjustmentModel = { ...hydrated, partialWhiteBalance: null };
              // The existing XMP number codec rounds a camera coordinate to
              // two decimals. This complete-pair write may cross a byte boundary.
              const authoredRgb = render(bytes, serializer.serialize(authored)).rgb;
              const difference = authoredRgb.map((value, i) => Math.abs(value - original.rgb[i]));
              expect(Math.max(...difference)).toBeLessThanOrEqual(1);
              expect(
                difference.reduce((sum, value) => sum + value, 0) / difference.length,
              ).toBeLessThanOrEqual(0.1);
              const wrongDefault = axis.includes('Temperature')
                ? { ...authored, tint: 0 }
                : { ...authored, temperature: 6500 };
              if (!axis.endsWith('="0"') && !axis.endsWith('="6500"')) {
                expect([...render(bytes, serializer.serialize(wrongDefault)).rgb]).not.toEqual([
                  ...original.rgb,
                ]);
              }
            }
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
