import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import {
  hydratePartialWhiteBalance,
  whiteBalanceAuthoredPatch,
} from '../models/partial-white-balance';
import { canUseLiveFastPath } from '../components/image-canvas/image-canvas.live-params';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { authoredPairToV5 } from './xmp-wb-scale';

const parser = new XmpParserService();
const serializer = new XmpSerializerService();
function sidecar(attrs: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" ${attrs}/></rdf:RDF></x:xmpmeta>`;
}
function read(xml: string) {
  return { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(xml).model };
}

describe('partial white balance import intent (#3434)', () => {
  for (const attrs of [
    'crs:Temperature="8500"',
    'crs:Tint="40"',
    'crs:Temperature="6500"',
    'crs:Tint="0"',
  ]) {
    it(`preserves presence through a real sidecar, hydration and unrelated save: ${attrs}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'maple-partial-wb-'));
      try {
        const path = join(directory, 'photo.xmp');
        writeFileSync(path, sidecar(attrs));
        const imported = read(readFileSync(path, 'utf8'));
        const hydrated = hydratePartialWhiteBalance(imported, 5520.125, -43.79, true);
        const edited = { ...hydrated, exposure: 1.25 };
        writeFileSync(path, serializer.serialize(edited));
        const saved = readFileSync(path, 'utf8');
        expect(saved).toContain(attrs);
        expect(saved).not.toContain(
          attrs.includes('Temperature') ? 'crs:Tint=' : 'crs:Temperature=',
        );
        expect(read(saved).partialWhiteBalance).toEqual(imported.partialWhiteBalance);
        expect(canUseLiveFastPath({ ...edited, sharpenAmount: 0, nrColor: 0 })).toBe(false);
        expect(hydrated.temperature).toBe(imported.partialWhiteBalance?.temperature ?? 5520.125);
        expect(hydrated.tint).toBe(imported.partialWhiteBalance?.tint ?? -43.79);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it('writes both explicit defaults for an authored pair', () => {
    const model = read(sidecar('crs:Temperature="6500" crs:Tint="0"'));
    expect(model.partialWhiteBalance).toBeNull();
    const saved = serializer.serialize(model);
    expect(saved).toContain('crs:Temperature="6500"');
    expect(saved).toContain('crs:Tint="0"');
    expect(read(saved).partialWhiteBalance).toBeNull();
  });

  for (const version of [2, 3, 4]) {
    it(`defers partial V${version} joint conversion until the calibrated camera arrives`, () => {
      const attrs = `crs:Temperature="8500" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:WbScaleVersion="${version}"`;
      const imported = read(sidecar(attrs));
      const hydrated = hydratePartialWhiteBalance(imported, 5520, -43.79, true);
      const pair = authoredPairToV5(8500, -43.79, version);
      expect([hydrated.temperature, hydrated.tint]).toEqual(pair);
      const saved = serializer.serialize(hydrated);
      expect(saved).toContain(`papp:WbScaleVersion="${version}"`);
      expect(saved).toContain('crs:Temperature="8500"');
      expect(saved).not.toContain('crs:Tint=');
      expect(hydratePartialWhiteBalance(imported, 5520, -43.79, false).partialWhiteBalance).toEqual(
        imported.partialWhiteBalance,
      );
    });
  }

  it('authoring supersedes partial intent, while a complete undo snapshot restores it', () => {
    const imported = read(sidecar('crs:Temperature="8500"'));
    const hydrated = hydratePartialWhiteBalance(imported, 5520, -43.79, true);
    for (const patch of [
      { temperature: 8500 },
      { tint: 0 },
      { whiteBalancePreset: 'Daylight' as const },
    ]) {
      const authored = { ...hydrated, ...whiteBalanceAuthoredPatch(patch) };
      expect(authored.partialWhiteBalance).toBeNull();
      expect(serializer.serialize(authored)).toContain('crs:Tint=');
    }
    expect(whiteBalanceAuthoredPatch(structuredClone(hydrated)).partialWhiteBalance).toEqual(
      imported.partialWhiteBalance,
    );
    expect(whiteBalanceAuthoredPatch({ exposure: 2 })).toEqual({ exposure: 2 });
  });
});
