import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import {
  hydratePartialWhiteBalance,
  isUnresolvedAuto,
  whiteBalanceAuthoredPatch,
  withResolvedImportedAuto,
} from '../models/partial-white-balance';
import { renderModelForCrop } from '../components/image-canvas/image-canvas.crop';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const parser = new XmpParserService();
const serializer = new XmpSerializerService();
const nameOnly =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>';
function read(xml: string) {
  return { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(xml).model };
}

describe('imported name-only Auto white balance (#4669)', () => {
  it('keeps the intent through a real sidecar and an unrelated save', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maple-auto-wb-'));
    try {
      const path = join(directory, 'photo.xmp');
      writeFileSync(path, nameOnly);
      const imported = read(readFileSync(path, 'utf8'));
      expect(imported.partialWhiteBalance).toEqual({ version: 5 });
      expect(isUnresolvedAuto(imported.partialWhiteBalance)).toBe(true);
      writeFileSync(path, serializer.serialize({ ...imported, exposure: 1 }));
      const saved = readFileSync(path, 'utf8');
      expect(saved).toContain('crs:WhiteBalance="Auto"');
      expect(saved).not.toMatch(/crs:(Temperature|Tint)=/);
      expect(read(saved).partialWhiteBalance).toEqual({ version: 5 });
      const explicit = read(
        nameOnly.replace(
          'WhiteBalance="Auto"',
          'WhiteBalance="Auto" crs:Temperature="6500" crs:Tint="0"',
        ),
      );
      expect(explicit.partialWhiteBalance).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders As Shot until resolved, then the pair, while the sidecar stays name-only', () => {
    const imported = read(nameOnly);
    const firstFrame = hydratePartialWhiteBalance(imported, 5520, 7.5, true);
    expect([firstFrame.temperature, firstFrame.tint]).toEqual([5520, 7.5]);
    expect(serializer.serialize(renderModelForCrop(firstFrame, false))).not.toMatch(
      /crs:Temperature=/,
    );

    const resolved = withResolvedImportedAuto(firstFrame, { temperature: 4013, tint: 16 });
    expect([resolved.temperature, resolved.tint, resolved.wbScaleVersion]).toEqual([4013, 16, 5]);
    expect(withResolvedImportedAuto(resolved, { temperature: 1, tint: 2 })).toBe(resolved);
    // A later camera re-seed keeps the resolved pair.
    expect(hydratePartialWhiteBalance(resolved, 5520, 7.5, true).temperature).toBe(4013);

    const rendered = serializer.serialize(renderModelForCrop(resolved, false));
    expect(rendered).toContain('crs:Temperature="4013"');
    expect(rendered).toContain('crs:Tint="16"');
    const stored = serializer.serialize({ ...resolved, exposure: 1 });
    expect(stored).toContain('crs:WhiteBalance="Auto"');
    expect(stored).not.toMatch(/crs:(Temperature|Tint)=/);

    // A numeric WB action supersedes the intent and is never re-estimated.
    const authored = { ...resolved, ...whiteBalanceAuthoredPatch({ temperature: 5300 }) };
    expect(authored.partialWhiteBalance).toBeNull();
    expect(withResolvedImportedAuto(authored, { temperature: 1, tint: 2 })).toBe(authored);
  });
});
