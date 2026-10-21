// color-curves-xmp.spec.ts — Oklab secondary colour curves and the
// zone-isolation fields in the sidecar (#5039, #5040, #5041).
//
// `CANONICAL_BLOCK` is the cross-language parity artifact: the same literal
// appears in the Rust suite (`raw-core/src/xmp/tests_color_curves.rs`), the
// Swift suite (`ColorCurveXMPTests.swift`) and the C# suite
// (`ColorCurveXmpTests.cs`). A sidecar written before these fields existed
// must parse to the defaults, and a default model must serialize none of
// them, so old sidecars render unchanged.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { toneCurveBlocks } from './xmp-tone-curves';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, ToneCurvePoint } from '../models/adjustment-model';

const CANONICAL_INDENT = '      ';

const CANONICAL_BLOCK = [
  '      <papp:ColorCurveHueVsSat>',
  '        <rdf:Seq>',
  '          <rdf:li>0, 128</rdf:li>',
  '          <rdf:li>85, 191</rdf:li>',
  '          <rdf:li>255, 128</rdf:li>',
  '        </rdf:Seq>',
  '      </papp:ColorCurveHueVsSat>',
].join('\n');

const CANONICAL_POINTS: ToneCurvePoint[] = [
  [0, 128 / 255],
  [85 / 255, 191 / 255],
  [1, 128 / 255],
];

const NEW_KEYS = [
  'papp:ColorCurveHueVsHue',
  'papp:ColorCurveHueVsSat',
  'papp:ColorCurveHueVsLuma',
  'papp:ColorCurveLumaVsSat',
  'papp:ColorCurveSatVsSat',
  'papp:ColorCurveSatVsLuma',
  'papp:ColorGradeBlending',
  'papp:ColorGradeShadowEdge',
  'papp:ColorGradeHighlightEdge',
  'papp:ToneCurveMode',
];

function sidecar(children: string): string {
  return [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:papp="http://ns.justmaple.app/photo/1.0/"',
    '    crs:Version="11.0">',
    children,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

function editedModel(): AdjustmentModel {
  return {
    ...defaultAdjustmentModel(),
    colorCurveHueVsHue: {
      points: [
        [0, 0.5],
        [0.5, 0.75],
        [1, 0.5],
      ],
    },
    colorCurveHueVsSat: { points: CANONICAL_POINTS },
    colorCurveHueVsLuma: {
      points: [
        [0.2, 0.4],
        [0.6, 0.6],
      ],
    },
    colorCurveLumaVsSat: {
      points: [
        [0, 0.5],
        [1, 0.8],
      ],
    },
    colorCurveSatVsSat: {
      points: [
        [0, 0],
        [1, 0.9],
      ],
    },
    colorCurveSatVsLuma: {
      points: [
        [0.1, 0.5],
        [0.9, 0.3],
      ],
    },
    colorGradeBlending: 40,
    colorGradeShadowEdge: 0.3,
    colorGradeHighlightEdge: 0.7,
    toneCurveMode: 'RatioPreserving',
  };
}

describe('XMP colour curves and zone isolation (#5039, #5040, #5041)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('serializes the canonical block from a hue-vs-sat curve', () => {
    const model: AdjustmentModel = {
      ...defaultAdjustmentModel(),
      colorCurveHueVsSat: { points: CANONICAL_POINTS },
    };
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  it('parses the canonical block and round-trips it byte-for-byte', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    model.colorCurveHueVsSat?.points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(CANONICAL_POINTS[i][0], 12);
      expect(y).toBeCloseTo(CANONICAL_POINTS[i][1], 12);
    });
    expect(model.colorCurveHueVsHue).toBeUndefined();
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  it('round-trips every new field through a full sidecar', () => {
    const model = editedModel();
    const back = parser.parseAdjustmentModel(serializer.serialize(model)).model;
    for (const key of [
      'colorCurveHueVsHue',
      'colorCurveHueVsSat',
      'colorCurveHueVsLuma',
      'colorCurveLumaVsSat',
      'colorCurveSatVsSat',
      'colorCurveSatVsLuma',
    ] as const) {
      expect(back[key]?.points.length, key).toBe(model[key].points.length);
      back[key]?.points.forEach(([x, y], i) => {
        expect(x, key).toBeCloseTo(model[key].points[i][0], 2);
        expect(y, key).toBeCloseTo(model[key].points[i][1], 2);
      });
    }
    expect(back.colorGradeBlending).toBe(40);
    expect(back.colorGradeShadowEdge).toBeCloseTo(0.3, 6);
    expect(back.colorGradeHighlightEdge).toBeCloseTo(0.7, 6);
    expect(back.toneCurveMode).toBe('RatioPreserving');
  });

  it('serializes none of the new fields for a default model', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    for (const key of NEW_KEYS) expect(xml, key).not.toContain(key);
  });

  it('parses a sidecar written before the fields existed to the defaults', () => {
    const old = serializer.serialize({ ...defaultAdjustmentModel(), brightness: 12 });
    const defaults = defaultAdjustmentModel();
    const merged = { ...defaults, ...parser.parseAdjustmentModel(old).model };
    expect(merged.brightness).toBe(12);
    for (const key of [
      'colorCurveHueVsHue',
      'colorCurveHueVsSat',
      'colorCurveHueVsLuma',
      'colorCurveLumaVsSat',
      'colorCurveSatVsSat',
      'colorCurveSatVsLuma',
    ] as const) {
      expect(merged[key].points, key).toEqual([]);
    }
    expect(merged.colorGradeBlending).toBe(defaults.colorGradeBlending);
    expect(merged.colorGradeShadowEdge).toBe(defaults.colorGradeShadowEdge);
    expect(merged.colorGradeHighlightEdge).toBe(defaults.colorGradeHighlightEdge);
    expect(merged.toneCurveMode).toBe(defaults.toneCurveMode);
  });

  it('emits only its own new key for a single edit', () => {
    const xml = serializer.serialize({ ...defaultAdjustmentModel(), colorGradeBlending: 40 });
    expect(xml).toContain('papp:ColorGradeBlending');
    for (const key of NEW_KEYS.filter((k) => k !== 'papp:ColorGradeBlending')) {
      expect(xml, key).not.toContain(key);
    }
  });
});
