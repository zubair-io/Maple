// known-attributes-idempotence.spec.ts — the known-set guard behind the
// passthrough design (#4686). `KNOWN_ATTRIBUTES` in `xmp-passthrough.ts` is
// hand-maintained; an attribute the serializer emits but that set does not
// claim parses into the model AND the passthrough bucket, so the second save
// writes it twice and the XML stops being well-formed. Omit-on-default fields
// are where such a gap hides — a sidecar carries them only once the user
// touches the control — so the fixture here sets EVERY one of them, and the
// round trip goes through a real `.xmp` file in a temp directory.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import { ADJUSTMENT_FIELDS } from './xmp-fields';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const DEFAULTS = defaultAdjustmentModel();

/** A value the omit-on-default rule will not suppress, one step off the default. */
const offDefault = (value: number): number => (value === 0 ? 1 : value - 1);

/**
 * Every numeric field in the shared table moved off its default, plus every
 * enum / string / nested field the serializer gates on a non-default value.
 * `whiteBalancePreset: 'Custom'` is what lets the WB pair be authored at all.
 */
function fullyNonDefaultModel(): AdjustmentModel {
  const numeric = Object.fromEntries(
    ADJUSTMENT_FIELDS.map((field) => [field.modelKey, offDefault(DEFAULTS[field.modelKey])]),
  );
  return {
    ...DEFAULTS,
    ...numeric,
    whiteBalancePreset: 'Custom',
    temperature: 5200,
    tint: -14.5,
    wbMethod: 'DiagonalRec2020',
    wbSource: 'Sampled',
    wbSampleX: 0.25,
    wbSampleY: 0.75,
    wbAlgorithmVersion: 2,
    highlightRecovery: 'Blend',
    autoExposure: 'Off',
    toneCurveMode: 'RatioPreserving',
    blackWhite: 'On',
    hotPixelSuppression: 'On',
    look: 'Neutral',
    profile: 'Neutral',
    filmLook: 'slide_fuji_velvia_50',
    filmStrength: 65,
    lensProfile: 'lcp1:0123456789abcdef',
    demosaic: 'Rcd',
    lensProfileEnable: 'Off',
    autoLateralCa: 'On',
    crop: { top: 0.1, left: 0.05, bottom: 0.9, right: 0.95, angle: 2.5 },
    toneCurveLuma: {
      points: [
        [0, 0],
        [0.5, 0.55],
        [1, 1],
      ],
    },
  };
}

const culling = {
  rating: 4,
  flag: 'pick',
  colorLabel: 'green',
  keywords: ['alpha', 'bravo & co'],
} as const;

const occurrences = (xml: string, attribute: string): number =>
  xml.split(`${attribute}=`).length - 1;

describe('XMP known-attribute set covers every emitted attribute (#4686)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;
  let dir: string;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
    dir = mkdtempSync(join(tmpdir(), 'maple-xmp-4686-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the fixture actually emits every omit-on-default attribute', () => {
    const xml = serializer.serialize(fullyNonDefaultModel(), undefined, culling);
    for (const field of ADJUSTMENT_FIELDS) {
      expect(xml, `${field.xmpKey} must be emitted by the fixture`).toContain(`${field.xmpKey}=`);
    }
    for (const attribute of [
      'papp:Look',
      'papp:Profile',
      'papp:FilmLook',
      'papp:LensProfile',
      'papp:Demosaic',
      'papp:HotPixelSuppression',
      'papp:WbMethod',
      'papp:WbSource',
      'papp:ToneCurveMode',
      'papp:HighlightRecoveryMode',
      'papp:AutoExposure',
      'crs:LensProfileEnable',
      'crs:AutoLateralCA',
      'crs:ConvertToGrayscale',
      'crs:HasCrop',
      'crs:CropAngle',
      'xmp:Rating',
      'papp:Flag',
      'papp:ColorLabel',
    ]) {
      expect(xml, `${attribute} must be emitted by the fixture`).toContain(`${attribute}=`);
    }
  });

  it('files nothing a Maple-authored sidecar carries as passthrough', () => {
    const xml = serializer.serialize(fullyNonDefaultModel(), undefined, culling);
    const { passthrough } = parser.parseAdjustmentModel(xml);
    expect(passthrough.unknownAttributes).toEqual([]);
    expect(passthrough.unknownNodes).toEqual([]);
  });

  it('serialize → file → parse → serialize is a fixed point with every field set', () => {
    const path = join(dir, 'DSCF1234.xmp');
    const first = serializer.serialize(fullyNonDefaultModel(), undefined, culling);
    writeFileSync(path, first, 'utf8');

    const source = readFileSync(path, 'utf8');
    const { model, passthrough } = parser.parseAdjustmentModel(source);
    expect(model.filmLook).toBe('slide_fuji_velvia_50');
    expect(model.filmStrength).toBe(65);
    expect(model.demosaic).toBe('Rcd');

    const merged = { ...defaultAdjustmentModel(), ...model };
    const second = serializer.serialize(merged, passthrough, culling);
    for (const attribute of ['papp:Demosaic', 'papp:FilmLook', 'papp:FilmStrength']) {
      expect(occurrences(second, attribute), `${attribute} must be written exactly once`).toBe(1);
    }
    expect(second).toBe(first);
  });
});
