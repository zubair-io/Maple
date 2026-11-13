import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
const FIXTURES = ['lightroom-adobe-color.xmp', 'lightroom-adobe-monochrome.xmp'].map((name) => ({
  name,
  xml: readFileSync(resolve('../../test-fixtures/look-profiles', name), 'utf8'),
}));

/**
 * The look as the DOM sees it: the single `crs:Look` element, serialized
 * with namespace declarations dropped and whitespace runs collapsed, so a
 * writer that re-indents an open tag still has to keep every attribute,
 * value and curve point.
 */
const canonicalLook = (xml: string): string => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const looks = doc.getElementsByTagNameNS(CRS, 'Look');
  expect(looks).toHaveLength(1);
  return new XMLSerializer()
    .serializeToString(looks[0])
    .replace(/\s+xmlns(:\w+)?="[^"]*"/g, '')
    .replace(/\s+/g, ' ');
};

describe("Lightroom's crs:Look profile block (#4685)", () => {
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'maple-look-profile-'));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(FIXTURES)('$name parses to the default model', ({ xml }) => {
    const { model, passthrough } = parser.parseAdjustmentModel(xml);
    expect({ ...defaultAdjustmentModel(), ...model }).toEqual(defaultAdjustmentModel());
    expect(passthrough.unknownNodes).toHaveLength(1);
    expect(canonicalLook(passthrough.unknownNodes[0])).toBe(canonicalLook(xml));
  });

  it.each(FIXTURES)('$name keeps the look through an on-disk edit', async ({ name, xml }) => {
    const sidecar = join(directory, name);
    await fs.writeFile(sidecar, xml);
    for (let save = 0; save < 2; save++) {
      const parsed = parser.parseAdjustmentModel(await fs.readFile(sidecar, 'utf8'));
      const model = { ...defaultAdjustmentModel(), ...parsed.model, exposure: 1.25 };
      await fs.writeFile(sidecar, serializer.serialize(model, parsed.passthrough, {}));
      const written = await fs.readFile(sidecar, 'utf8');
      expect(written).toContain('crs:Exposure2012="1.25"');
      expect(canonicalLook(written)).toBe(canonicalLook(xml));
      expect(written.split('crs:ConvertToGrayscale="True"')).toHaveLength(
        xml.split('crs:ConvertToGrayscale="True"').length,
      );
      const reparsed = parser.parseAdjustmentModel(written).model;
      expect(reparsed.exposure).toBe(1.25);
      expect(reparsed.blackWhite ?? 'Off').toBe('Off');
      expect(reparsed.displayToneCurveLuma ?? { points: [] }).toEqual({ points: [] });
    }
  });
});
