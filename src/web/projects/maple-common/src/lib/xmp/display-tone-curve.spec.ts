// display-tone-curve.spec.ts — nested-element XMP I/O for the four
// display-referred point tone curves (#2232, Adobe's `crs:ToneCurvePV2012*`).
//
// Sibling of `point-tone-curve.spec.ts` (the scene-linear `papp:` family).
// `CANONICAL_BLOCK` here is this ticket's own cross-language parity artifact
// — the same literal must appear in `tests_display_tone_curves.rs` and
// `ToneCurveXMPTests.swift`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { toneCurveBlocks } from './xmp-tone-curves';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, ToneCurvePoint } from '../models/adjustment-model';

/** Child indent used by the parity fixture (`docs/xmp-canonical-format.md`
 * § "Indentation"). */
const CANONICAL_INDENT = '      ';

/** Cross-language byte-parity fixture — a non-identity three-point master
 * curve (deliberately a different shape from `point-tone-curve.spec.ts`'
 * five-point fixture). */
const CANONICAL_BLOCK = [
  '      <crs:ToneCurvePV2012>',
  '        <rdf:Seq>',
  '          <rdf:li>0, 0</rdf:li>',
  '          <rdf:li>128, 150</rdf:li>',
  '          <rdf:li>255, 255</rdf:li>',
  '        </rdf:Seq>',
  '      </crs:ToneCurvePV2012>',
].join('\n');

/** The `[0, 1]` model form of `CANONICAL_BLOCK`. */
const CANONICAL_POINTS: ToneCurvePoint[] = [
  [0, 0],
  [128 / 255, 150 / 255],
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

/** A real Lightroom Classic export — the same fixture the Rust and Swift
 * suites use (`tests_display_tone_curves::ACR_AUTHORED_SIDECAR`,
 * `XMPPassthroughTests.lightroomSidecar`) — carrying a master
 * `crs:ToneCurvePV2012`, a mask group, a snapshot stack and an edit history.
 * Before #2232 all four rode the unknown-node passthrough; now the curve
 * parses structurally and the other three stay passthrough. */
const ACR_AUTHORED_SIDECAR = [
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.0-c001 79.b0f8be9">',
  ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '  <rdf:Description rdf:about=""',
  '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
  '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  '    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
  '    xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"',
  '   xmp:Rating="3"',
  '   xmpMM:DocumentID="xmp.did:9a5f1b40-2c1b-4a2f-9d3d-1f0b2c4d5e6f"',
  '   xmpMM:InstanceID="xmp.iid:0e3a7c21-91d5-4b0c-8a44-2f7c1e8d9a10"',
  '   crs:Version="15.0"',
  '   crs:ProcessVersion="11.0"',
  '   crs:Exposure2012="+0.35"',
  '   crs:Contrast2012="+10"',
  '   crs:RawFileName="DSCF1234.RAF"',
  '   crs:CameraProfile="Adobe Standard &amp; Neutral"',
  '   crs:HasSettings="True">',
  '   <crs:ToneCurvePV2012>',
  '    <rdf:Seq>',
  '     <rdf:li>0, 0</rdf:li>',
  '     <rdf:li>32, 22</rdf:li>',
  '     <rdf:li>255, 255</rdf:li>',
  '    </rdf:Seq>',
  '   </crs:ToneCurvePV2012>',
  '   <crs:MaskGroupBasedCorrections>',
  '    <rdf:Seq>',
  '     <rdf:li>',
  '      <rdf:Description',
  '       crs:What="Correction"',
  '       crs:CorrectionAmount="1"',
  '       crs:LocalExposure2012="+0.500000">',
  '      <crs:CorrectionMasks>',
  '       <rdf:Seq>',
  '        <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.5" crs:ZeroY="0.1"/>',
  '       </rdf:Seq>',
  '      </crs:CorrectionMasks>',
  '      </rdf:Description>',
  '     </rdf:li>',
  '    </rdf:Seq>',
  '   </crs:MaskGroupBasedCorrections>',
  '   <crs:Snapshots>',
  '    <rdf:Bag>',
  '     <rdf:li>Import</rdf:li>',
  '    </rdf:Bag>',
  '   </crs:Snapshots>',
  '   <xmpMM:History>',
  '    <rdf:Seq>',
  '     <rdf:li stEvt:action="derived" stEvt:parameters="converted 5 &gt; 4 stops"/>',
  '     <rdf:li stEvt:action="saved" stEvt:when="2026-01-04T10:11:12-05:00"/>',
  '    </rdf:Seq>',
  '   </xmpMM:History>',
  '  </rdf:Description>',
  ' </rdf:RDF>',
  '</x:xmpmeta>',
  '<?xpacket end="w"?>',
].join('\n');

describe('XMP display-referred point tone curves (#2232)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  // ── Parse ────────────────────────────────────────────────────────────────

  it('parses a nested three-point master curve', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(model.displayToneCurveLuma?.points.length).toBe(3);
    model.displayToneCurveLuma?.points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(CANONICAL_POINTS[i][0], 12);
      expect(y).toBeCloseTo(CANONICAL_POINTS[i][1], 12);
    });
    // Only the master curve was authored — the scene-linear family and the
    // display-referred R/G/B siblings stay absent from the partial model.
    expect(model.toneCurveLuma).toBeUndefined();
    expect(model.displayToneCurveRed).toBeUndefined();
  });

  /**
   * The load-bearing acceptance test: bytes → model → bytes is the identity
   * function for a non-identity display-referred curve.
   */
  it('round-trips a three-point curve byte-for-byte', () => {
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
      displayToneCurveLuma: { points: CANONICAL_POINTS },
    };
    expect(toneCurveBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('emits nothing for identity curves', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('ToneCurvePV2012');
  });

  // ── Full-document round trip ──────────────────────────────────────────────

  it('coexists with the scene-linear family and emits in canonical order', () => {
    const model: AdjustmentModel = {
      ...defaultAdjustmentModel(),
      toneCurveLuma: {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      displayToneCurveLuma: {
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      displayToneCurveRed: {
        points: [
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ],
      },
      displayToneCurveGreen: {
        points: [
          [0, 0],
          [0.25, 0.2],
          [1, 1],
        ],
      },
      displayToneCurveBlue: {
        points: [
          [0, 0.1],
          [1, 0.9],
        ],
      },
    };
    const xml = serializer.serialize(model);
    const positions = [
      '<papp:SceneLinearToneCurve>',
      '<crs:ToneCurvePV2012>',
      '<crs:ToneCurvePV2012Red>',
      '<crs:ToneCurvePV2012Green>',
      '<crs:ToneCurvePV2012Blue>',
    ].map((tag) => xml.indexOf(tag));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    const { model: reparsed } = parser.parseAdjustmentModel(xml);
    expect(reparsed.toneCurveLuma).toEqual(model.toneCurveLuma);
    expect(reparsed.displayToneCurveLuma).toEqual(model.displayToneCurveLuma);
    expect(reparsed.displayToneCurveRed).toEqual(model.displayToneCurveRed);
    expect(reparsed.displayToneCurveGreen).toEqual(model.displayToneCurveGreen);
    expect(reparsed.displayToneCurveBlue).toEqual(model.displayToneCurveBlue);
    expect(serializer.serialize({ ...defaultAdjustmentModel(), ...reparsed })).toBe(xml);
  });

  // ── Real ACR-authored sample ────────────────────────────────────────────

  it('parses the master curve from a real Lightroom Classic export', () => {
    const { model, passthrough } = parser.parseAdjustmentModel(ACR_AUTHORED_SIDECAR);
    expect(model.displayToneCurveLuma?.points.length).toBe(3);
    const expected: ToneCurvePoint[] = [
      [0, 0],
      [32 / 255, 22 / 255],
      [1, 1],
    ];
    model.displayToneCurveLuma?.points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i][0], 6);
      expect(y).toBeCloseTo(expected[i][1], 6);
    });
    // Flat attributes on the same element still parse alongside the nested
    // curve.
    expect(model.exposure).toBeCloseTo(0.35, 9);
    // The mask group / snapshot / history subtrees stay genuinely unknown —
    // only the curve moved off this bucket.
    expect(passthrough.unknownNodes.length).toBe(3);
    expect(passthrough.unknownNodes.join('')).not.toContain('ToneCurvePV2012');
  });
});
