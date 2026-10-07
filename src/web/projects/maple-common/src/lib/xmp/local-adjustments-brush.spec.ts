// local-adjustments-brush.spec.ts — the fourth local-adjustment container
// (#360, mirroring raw-core): `crs:PaintBasedCorrections`, carrying `brush`
// (painted dab series) masks. Split from `local-adjustments.spec.ts` for the
// same size-budget reason raw-core keeps `tests_local_adjustments_brush.rs`
// beside `tests_local_adjustments.rs`.
//
// `CANONICAL_PAINT_BLOCK` is the cross-language parity artifact: the same
// literal is pinned by the Rust suite (`tests_local_adjustments_brush.rs`)
// and the Swift suite (`LocalAdjustmentXMPTests.swift`); every writer that
// models this container must produce it byte-for-byte from the same layer at
// the same indent. (The C# writer passes the container through untouched and
// has no copy.)

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, LocalAdjustment } from '../models/adjustment-model';

/** Six spaces — the canonical depth for children of `rdf:Description`. */
const CANONICAL_INDENT = '      ';

/** `brush_layer()` in Rust: three dabs (paint, paint, erase), unresolved. */
const BRUSH_LAYER: LocalAdjustment = {
  mask: {
    kind: 'brush',
    dabs: [
      { center: { x: 0.25, y: 0.3 }, radius: 0.05, feather: 0.5, weight: 0.8, erase: false },
      { center: { x: 0.3, y: 0.35 }, radius: 0.05, feather: 0.5, weight: 0.8, erase: false },
      { center: { x: 0.275, y: 0.325 }, radius: 0.02, feather: 0, weight: 1, erase: true },
    ],
    digest: '0123456789abcdef',
    rasterId: 0,
  },
  adjustments: { exposure: 0.5 },
};

const CANONICAL_PAINT_BLOCK = [
  '      <crs:PaintBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalExposure2012="0.5">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Paint"',
  '                    crs:MaskValue="1"',
  '                    crs:Dabs="0.25 0.3 0.05 0.5 0.8 0 0.3 0.35 0.05 0.5 0.8 0 0.275 0.325 0.02 0 1 1"',
  '                    papp:BrushDigest="0123456789abcdef"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:PaintBasedCorrections>',
].join('\n');

/** Wrap a nested child block in a sidecar envelope. */
function sidecar(children: string): string {
  return [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    '    xmlns:papp="http://ns.justmaple.app/photo/1.0/"',
    '    crs:Version="11.0">',
    children,
    '  </rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** One paint correction with the given mask leaf. */
function paintCorrection(maskLeaf: string): string {
  return [
    '      <crs:PaintBasedCorrections>',
    '        <rdf:Seq>',
    '          <rdf:li>',
    '            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True">',
    '              <crs:CorrectionMasks>',
    '                <rdf:Seq>',
    `                  ${maskLeaf}`,
    '                </rdf:Seq>',
    '              </crs:CorrectionMasks>',
    '            </rdf:Description>',
    '          </rdf:li>',
    '        </rdf:Seq>',
    '      </crs:PaintBasedCorrections>',
  ].join('\n');
}

describe('XMP local adjustments — brush masks (#360)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  const withLayers = (layers: LocalAdjustment[]): AdjustmentModel => ({
    ...defaultAdjustmentModel(),
    localAdjustments: layers,
  });

  // ── Cross-language parity ────────────────────────────────────────────────

  it('serializes the canonical paint block from a hand-built model', () => {
    expect(localAdjustmentBlocks(withLayers([BRUSH_LAYER]), CANONICAL_INDENT)).toBe(
      CANONICAL_PAINT_BLOCK,
    );
  });

  it('parses the canonical paint block back to the brush layer', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_PAINT_BLOCK));
    expect(model.localAdjustments).toEqual([BRUSH_LAYER]);
  });

  it('round-trips a brush layer through the full serializer', () => {
    const doc = serializer.serialize(withLayers([BRUSH_LAYER]));
    expect(doc).toContain('crs:PaintBasedCorrections');
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([BRUSH_LAYER]);
  });

  it('drops a stamped raster id on write and reads back unresolved', () => {
    const stamped: LocalAdjustment = {
      ...BRUSH_LAYER,
      mask: {
        ...(BRUSH_LAYER.mask as Extract<LocalAdjustment['mask'], { kind: 'brush' }>),
        rasterId: 7,
      },
    };
    const doc = serializer.serialize(withLayers([stamped]));
    expect(doc).not.toContain('rasterId');
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([
      { ...stamped, mask: { ...stamped.mask, rasterId: 0 } },
    ]);
  });

  // ── Tolerant reader ──────────────────────────────────────────────────────

  it.each([
    ['odd token count', '0.5 0.5 0.05 0.5 1'],
    ['non-numeric token', '0.5 0.5 0.05 0.5 one 0'],
    ['non-finite token', '0.5 0.5 0.05 0.5 Infinity 0'],
    ['bad erase flag', '0.5 0.5 0.05 0.5 1 2'],
  ])('drops a correction with %s in crs:Dabs', (_name, dabs) => {
    const leaf = `<rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="${dabs}"/>`;
    expect(
      parser.parseAdjustmentModel(sidecar(paintCorrection(leaf))).model.localAdjustments,
    ).toEqual([]);
  });

  it('reads a missing crs:Dabs as an empty stroke, not an error', () => {
    const leaf = '<rdf:li crs:What="Mask/Paint" crs:MaskValue="1"/>';
    const { model } = parser.parseAdjustmentModel(sidecar(paintCorrection(leaf)));
    expect(model.localAdjustments).toEqual([
      {
        mask: { kind: 'brush', dabs: [], digest: '', rasterId: 0 },
        adjustments: {},
      },
    ]);
  });

  it('reads a missing digest as empty for foreign paint masks', () => {
    const leaf =
      '<rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="0.5 0.5 0.05 0.5 1 0"/>';
    const { model } = parser.parseAdjustmentModel(sidecar(paintCorrection(leaf)));
    expect(model.localAdjustments).toMatchObject([{ mask: { kind: 'brush', digest: '' } }]);
  });

  it('skips a paint leaf outside the paint container', () => {
    const doc = sidecar(
      [
        '      <crs:GradientBasedCorrections>',
        '        <rdf:Seq>',
        '          <rdf:li>',
        '            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True">',
        '              <crs:CorrectionMasks>',
        '                <rdf:Seq>',
        '                  <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="0.5 0.5 0.05 0.5 1 0"/>',
        '                </rdf:Seq>',
        '              </crs:CorrectionMasks>',
        '            </rdf:Description>',
        '          </rdf:li>',
        '        </rdf:Seq>',
        '      </crs:GradientBasedCorrections>',
      ].join('\n'),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  it('drops a group with a paint leaf rather than widening it', () => {
    const doc = sidecar(
      [
        '      <crs:MaskGroupBasedCorrections>',
        '        <rdf:Seq>',
        '          <rdf:li>',
        '            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" papp:MaskGroupVersion="1">',
        '              <crs:CorrectionMasks>',
        '                <rdf:Seq>',
        '                  <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="0.5 0.5 0.05 0.5 1 0"/>',
        '                </rdf:Seq>',
        '              </crs:CorrectionMasks>',
        '            </rdf:Description>',
        '          </rdf:li>',
        '        </rdf:Seq>',
        '      </crs:MaskGroupBasedCorrections>',
      ].join('\n'),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  // ── Writer ───────────────────────────────────────────────────────────────

  it('sorts the paint container after radial and before group', () => {
    const block = localAdjustmentBlocks(
      withLayers([
        BRUSH_LAYER,
        { mask: { kind: 'everywhere' }, adjustments: {} },
        {
          mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, feather: 0.5 },
          adjustments: {},
        },
      ]),
      CANONICAL_INDENT,
    );
    const order = [
      block.indexOf('crs:GradientBasedCorrections'),
      block.indexOf('crs:PaintBasedCorrections'),
      block.indexOf('crs:MaskGroupBasedCorrections'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('omits both crs:Dabs and the digest for an empty stroke', () => {
    const layer: LocalAdjustment = {
      mask: { kind: 'brush', dabs: [], digest: '', rasterId: 0 },
      adjustments: {},
    };
    const block = localAdjustmentBlocks(withLayers([layer]), CANONICAL_INDENT);
    expect(block).not.toContain('crs:Dabs');
    expect(block).not.toContain('papp:BrushDigest');
  });

  it('drops non-finite dabs on write', () => {
    const layer: LocalAdjustment = {
      mask: {
        kind: 'brush',
        dabs: [
          ...(BRUSH_LAYER.mask as Extract<LocalAdjustment['mask'], { kind: 'brush' }>).dabs,
          {
            center: { x: NaN, y: 0.5 },
            radius: 0.05,
            feather: 0.5,
            weight: 1,
            erase: false,
          },
        ],
        digest: '0123456789abcdef',
        rasterId: 0,
      },
      adjustments: {},
    };
    const block = localAdjustmentBlocks(withLayers([layer]), CANONICAL_INDENT);
    expect(block).not.toContain('NaN');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments).toMatchObject([
      {
        mask: {
          kind: 'brush',
          dabs: (BRUSH_LAYER.mask as Extract<LocalAdjustment['mask'], { kind: 'brush' }>).dabs,
        },
      },
    ]);
  });
});
