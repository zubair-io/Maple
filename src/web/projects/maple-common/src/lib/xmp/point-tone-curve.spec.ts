// point-tone-curve.spec.ts — nested-element XMP I/O for the four point tone
// curves (#365).
//
// `CANONICAL_BLOCK` below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_tone_curves.rs`)
// and the Swift suite (`ToneCurveXMPTests.swift`), and all three serializers
// must produce it byte-for-byte from the same model at the same indent. Rust
// ships only a fragment serializer and never writes a whole document, which
// is why the block rather than the file is this fixture's unit; whole-document
// parity between the Swift and TypeScript writers is #1577's `xmp-canonical`
// pair.
//
// The namespace decision this file pins: scene-linear point curves are
// `papp:SceneLinearToneCurve*`, and Lightroom's display-referred
// `crs:ToneCurvePV2012*` is NOT read into those fields — it survives a
// read-modify-write untouched through the unknown-node passthrough.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { toneCurveBlocks } from './xmp-tone-curves';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, ToneCurvePoint } from '../models/adjustment-model';

/**
 * Child indent used by the parity fixture. Six spaces is the canonical depth
 * for children of `rdf:Description` per `docs/xmp-canonical-format.md`
 * § "Indentation", and since #1577 it is also what this writer emits.
 */
const CANONICAL_INDENT = '      ';

/** Cross-language byte-parity fixture — a non-identity five-point luma curve. */
const CANONICAL_BLOCK = [
  '      <papp:SceneLinearToneCurve>',
  '        <rdf:Seq>',
  '          <rdf:li>0, 0</rdf:li>',
  '          <rdf:li>64, 48</rdf:li>',
  '          <rdf:li>128, 140</rdf:li>',
  '          <rdf:li>192, 205</rdf:li>',
  '          <rdf:li>255, 255</rdf:li>',
  '        </rdf:Seq>',
  '      </papp:SceneLinearToneCurve>',
].join('\n');

/** The `[0, 1]` model form of `CANONICAL_BLOCK`. */
const CANONICAL_POINTS: ToneCurvePoint[] = [
  [0, 0],
  [64 / 255, 48 / 255],
  [128 / 255, 140 / 255],
  [192 / 255, 205 / 255],
  [1, 1],
];

/** Wrap a nested child block in a sidecar envelope. */
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

describe('XMP point tone curves (#365)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  // ── Parse ────────────────────────────────────────────────────────────────

  it('parses a nested five-point luma curve', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(model.toneCurveLuma?.points.length).toBe(5);
    model.toneCurveLuma?.points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(CANONICAL_POINTS[i][0], 12);
      expect(y).toBeCloseTo(CANONICAL_POINTS[i][1], 12);
    });
    // Only the luma channel was authored — the others stay absent from the
    // partial model and take the identity default on merge.
    expect(model.toneCurveRed).toBeUndefined();
  });

  /**
   * The load-bearing acceptance test: bytes → model → bytes is the identity
   * function for a non-identity five-point curve.
   */
  it('round-trips a five-point curve byte-for-byte', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  /**
   * Cross-language parity: the exact bytes Rust's `serialize_tone_curves` and
   * Swift's `_buildToneCurvesBlock` emit for the same model at the same indent.
   */
  it('serializes the canonical block from a hand-built model', () => {
    const model: AdjustmentModel = {
      ...defaultAdjustmentModel(),
      toneCurveLuma: { points: CANONICAL_POINTS },
    };
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  /**
   * Identity is silence — an unedited model must add nothing to the document,
   * so a sidecar written before #365 stays byte-identical after a re-save.
   */
  it('emits nothing for identity curves', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('SceneLinearToneCurve');
    expect(xml).not.toContain('rdf:Seq');
  });

  it('parses an empty rdf:Seq as identity and re-emits nothing', () => {
    const block = [
      '      <papp:SceneLinearToneCurve>',
      '        <rdf:Seq>',
      '        </rdf:Seq>',
      '      </papp:SceneLinearToneCurve>',
    ].join('\n');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.toneCurveLuma?.points).toEqual([]);
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe('');
  });

  // ── Full-document round trip ──────────────────────────────────────────────

  it('round-trips all four channels through the serializer', () => {
    const model: AdjustmentModel = {
      ...defaultAdjustmentModel(),
      toneCurveLuma: {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      toneCurveRed: {
        points: [
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ],
      },
      toneCurveGreen: {
        points: [
          [0, 0],
          [0.25, 0.2],
          [1, 1],
        ],
      },
      toneCurveBlue: {
        points: [
          [0, 0.1],
          [1, 0.9],
        ],
      },
    };
    const xml = serializer.serialize(model);
    // Canonical child order: luma, red, green, blue.
    const positions = [
      '<papp:SceneLinearToneCurve>',
      '<papp:SceneLinearToneCurveRed>',
      '<papp:SceneLinearToneCurveGreen>',
      '<papp:SceneLinearToneCurveBlue>',
    ].map((tag) => xml.indexOf(tag));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    const { model: reparsed } = parser.parseAdjustmentModel(xml);
    expect(reparsed.toneCurveLuma).toEqual(model.toneCurveLuma);
    expect(reparsed.toneCurveRed).toEqual(model.toneCurveRed);
    expect(reparsed.toneCurveGreen).toEqual(model.toneCurveGreen);
    expect(reparsed.toneCurveBlue).toEqual(model.toneCurveBlue);
    expect(serializer.serialize({ ...defaultAdjustmentModel(), ...reparsed })).toBe(xml);
  });

  it('round-trips fractional wire coordinates through the 2-decimal codec', () => {
    const block = [
      '      <papp:SceneLinearToneCurveRed>',
      '        <rdf:Seq>',
      '          <rdf:li>0, 0</rdf:li>',
      '          <rdf:li>127.5, 130.25</rdf:li>',
      '          <rdf:li>255, 255</rdf:li>',
      '        </rdf:Seq>',
      '      </papp:SceneLinearToneCurveRed>',
    ].join('\n');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toContain('<rdf:li>127.5, 130.25</rdf:li>');
  });

  it('does not surface managed curve elements in passthrough.unknownNodes', () => {
    const { passthrough } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(passthrough.unknownNodes.join('')).not.toContain('SceneLinearToneCurve');
  });

  // ── Namespace decision ───────────────────────────────────────────────────

  /**
   * Lightroom's display-referred curves are a different quantity (post-AgX)
   * and must NOT land in the scene-linear fields — applying a display-referred
   * shape to scene-linear light renders the image visibly wrong.
   */
  it('does not parse crs:ToneCurvePV2012 into the scene-linear fields', () => {
    const block = [
      '      <crs:ToneCurvePV2012>',
      '        <rdf:Seq>',
      '          <rdf:li>0, 0</rdf:li>',
      '          <rdf:li>128, 180</rdf:li>',
      '          <rdf:li>255, 255</rdf:li>',
      '        </rdf:Seq>',
      '      </crs:ToneCurvePV2012>',
    ].join('\n');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.toneCurveLuma).toBeUndefined();
    expect(model.toneCurveRed).toBeUndefined();
    expect(model.toneCurveGreen).toBeUndefined();
    expect(model.toneCurveBlue).toBeUndefined();
  });

  /**
   * The other half of the decision: an imported Lightroom curve survives a
   * read-modify-write byte-for-byte through the nested-node passthrough, so
   * Maple never destroys an edit it declines to interpret.
   */
  it('preserves crs:ToneCurvePV2012 verbatim across a read-modify-write', () => {
    const pv2012 = [
      '  <crs:ToneCurvePV2012>',
      '   <rdf:Seq>',
      '    <rdf:li>0, 0</rdf:li>',
      '    <rdf:li>128, 180</rdf:li>',
      '    <rdf:li>255, 255</rdf:li>',
      '   </rdf:Seq>',
      '  </crs:ToneCurvePV2012>',
    ].join('\n');
    const source = sidecar(pv2012);

    const { model, passthrough } = parser.parseAdjustmentModel(source);
    // The nested element (not just attributes) reaches the passthrough bucket.
    expect(passthrough.unknownNodes.length).toBe(1);

    // Modify something Maple does own, then write.
    const edited: AdjustmentModel = {
      ...defaultAdjustmentModel(),
      ...model,
      exposure: 0.75,
      toneCurveLuma: { points: CANONICAL_POINTS },
    };
    const written = serializer.serialize(edited, passthrough);
    expect(written).toContain('crs:Exposure2012="0.75"');
    expect(written).toContain('<papp:SceneLinearToneCurve>');
    // The Lightroom curve came through untouched, byte for byte.
    expect(written).toContain(passthrough.unknownNodes[0]);

    // And a second read/write cycle is stable.
    const second = parser.parseAdjustmentModel(written);
    const rewritten = serializer.serialize(
      { ...defaultAdjustmentModel(), ...second.model },
      second.passthrough,
    );
    expect(rewritten).toBe(written);
  });

  // ── Interaction with the other nested element ────────────────────────────

  it('coexists with the dc:subject keyword bag', () => {
    const block = [
      '  <dc:subject>',
      '   <rdf:Bag>',
      '    <rdf:li>sunset</rdf:li>',
      '    <rdf:li>beach</rdf:li>',
      '   </rdf:Bag>',
      '  </dc:subject>',
      CANONICAL_BLOCK,
    ].join('\n');
    const source = sidecar(block);
    const culling = parser.parseCulling(source);
    const { model, passthrough } = parser.parseAdjustmentModel(source);
    expect(culling.keywords).toEqual(['sunset', 'beach']);
    expect(model.toneCurveLuma?.points.length).toBe(5);
    expect(passthrough.unknownNodes).toEqual([]);

    const xml = serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough, {
      keywords: culling.keywords,
    });
    expect(xml).toContain('<dc:subject>');
    expect(xml).toContain('<papp:SceneLinearToneCurve>');
    const round = parser.parseAdjustmentModel(xml);
    expect(round.model.toneCurveLuma).toEqual(model.toneCurveLuma);
    expect(parser.parseCulling(xml).keywords).toEqual(['sunset', 'beach']);
  });
});
