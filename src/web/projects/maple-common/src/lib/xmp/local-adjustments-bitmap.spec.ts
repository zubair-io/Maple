// local-adjustments-bitmap.spec.ts — the third local-adjustment container
// (#3300, mirroring raw-core's #3271): `crs:MaskGroupBasedCorrections`,
// carrying `bitmap` (person/skin raster) and `everywhere` masks. Split from
// `local-adjustments.spec.ts` for the same size-budget reason raw-core keeps
// `tests_local_adjustments_bitmap.rs` beside `tests_local_adjustments.rs`.
//
// `CANONICAL_GROUP_BLOCK` is the cross-language parity artifact: the same
// literal is pinned by the Rust suite (`tests_local_adjustments_bitmap.rs`)
// and the Swift suite (`XMPLocalAdjustmentsTests.swift`); every writer that
// models this container must produce it byte-for-byte from the same two
// layers at the same indent. (The C# writer passes the container through
// untouched and has no copy.)

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, LocalAdjustment } from '../models/adjustment-model';

/** Six spaces — the canonical depth for children of `rdf:Description`. */
const CANONICAL_INDENT = '      ';

/** `bitmap_layer()` in Rust: a Vision person/skin selection narrowed by the
 *  skin-tone range, `rasterId` unresolved on both sides of the wire. */
const BITMAP_LAYER: LocalAdjustment = {
  mask: {
    kind: 'bitmap',
    recipe: {
      person: 0,
      facialSkin: true,
      bodySkin: true,
      model: 'apple-vision-person-instance/1',
      digest: 'a1b2c3d4e5f60718',
    },
    rasterId: 0,
  },
  range: {
    kind: 'color',
    hueDeg: 55,
    hueHalfWidthDeg: 25,
    chromaMin: 0.02,
    lMin: 0.15,
    lMax: 0.95,
    feather: 0.3,
  },
  adjustments: { hue: 12 },
};

/** `everywhere_layer()` in Rust: the no-person-detected fallback. */
const EVERYWHERE_LAYER: LocalAdjustment = {
  mask: { kind: 'everywhere' },
  adjustments: { exposure: 0.3 },
};

const CANONICAL_GROUP_BLOCK = [
  '      <crs:MaskGroupBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalHue="0.12"',
  '              papp:RangeKind="Color"',
  '              papp:RangeHue="55"',
  '              papp:RangeHueWidth="25"',
  '              papp:RangeChromaMin="0.02"',
  '              papp:RangeLMin="0.15"',
  '              papp:RangeLMax="0.95"',
  '              papp:RangeFeather="0.3">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Image"',
  '                    crs:MaskSubType="1"',
  '                    crs:MaskValue="1"',
  '                    papp:MaskSource="PersonSkin"',
  '                    papp:MaskPerson="0"',
  '                    papp:MaskFacialSkin="True"',
  '                    papp:MaskBodySkin="True"',
  '                    papp:MaskModel="apple-vision-person-instance/1"',
  '                    papp:MaskDigest="a1b2c3d4e5f60718"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalExposure2012="0.3">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Image"',
  '                    crs:MaskValue="1"',
  '                    papp:MaskSource="Everywhere"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:MaskGroupBasedCorrections>',
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
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** One group correction with the given description attributes and mask leaf. */
function groupCorrection(descriptionAttrs: string, maskLeaf: string): string {
  return [
    '      <crs:MaskGroupBasedCorrections>',
    '        <rdf:Seq>',
    '          <rdf:li>',
    `            <rdf:Description ${descriptionAttrs}>`,
    '              <crs:CorrectionMasks>',
    '                <rdf:Seq>',
    `                  ${maskLeaf}`,
    '                </rdf:Seq>',
    '              </crs:CorrectionMasks>',
    '            </rdf:Description>',
    '          </rdf:li>',
    '        </rdf:Seq>',
    '      </crs:MaskGroupBasedCorrections>',
  ].join('\n');
}

const ACTIVE = 'crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True"';

describe('XMP local adjustments — bitmap + everywhere masks (#3300)', () => {
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

  it('serializes the canonical group block from a hand-built model', () => {
    expect(
      localAdjustmentBlocks(withLayers([BITMAP_LAYER, EVERYWHERE_LAYER]), CANONICAL_INDENT),
    ).toBe(CANONICAL_GROUP_BLOCK);
  });

  it('parses the canonical group block back into the fixture layers', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_GROUP_BLOCK));
    expect(model.localAdjustments).toEqual([BITMAP_LAYER, EVERYWHERE_LAYER]);
  });

  it('round-trips the canonical group block byte-for-byte', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_GROUP_BLOCK));
    expect(localAdjustmentBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_GROUP_BLOCK);
  });

  // ── Whole-document behaviour ─────────────────────────────────────────────

  it('rides the model, not the passthrough bucket, and re-saves as a fixed point', () => {
    const original = serializer.serialize(withLayers([BITMAP_LAYER, EVERYWHERE_LAYER]));
    expect(original).toContain(CANONICAL_GROUP_BLOCK);

    const { model, passthrough } = parser.parseAdjustmentModel(original);
    expect(passthrough.unknownNodes).toEqual([]);
    expect(model.localAdjustments).toEqual([BITMAP_LAYER, EVERYWHERE_LAYER]);

    const resaved = serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough);
    expect(resaved).toBe(original);
  });

  it('writes the group container after the two geometric containers', () => {
    const linear: LocalAdjustment = {
      mask: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, feather: 0.5 },
      adjustments: { exposure: 0.4 },
    };
    const radial: LocalAdjustment = {
      mask: {
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radii: { x: 0.25, y: 0.25 },
        angle: 0,
        feather: 0.5,
        invert: false,
      },
      adjustments: { contrast: 10 },
    };
    const block = localAdjustmentBlocks(
      withLayers([EVERYWHERE_LAYER, radial, BITMAP_LAYER, linear]),
      CANONICAL_INDENT,
    );
    const gradient = block.indexOf('<crs:GradientBasedCorrections>');
    const circular = block.indexOf('<crs:CircularGradientBasedCorrections>');
    const group = block.indexOf('<crs:MaskGroupBasedCorrections>');
    expect(gradient).toBeGreaterThanOrEqual(0);
    expect(circular).toBeGreaterThan(gradient);
    expect(group).toBeGreaterThan(circular);
    expect(block.match(/crs:What="Mask\/Image"/g)).toHaveLength(2);

    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments).toEqual([linear, radial, EVERYWHERE_LAYER, BITMAP_LAYER]);
  });

  it('escapes the free-text recipe fields exactly as raw-core does and reads them back', () => {
    const layer: LocalAdjustment = {
      mask: {
        kind: 'bitmap',
        recipe: { ...BITMAP_LAYER.mask, person: 2, facialSkin: false, bodySkin: true } as never,
        rasterId: 0,
      },
      adjustments: {},
    };
    const spiky: LocalAdjustment = {
      ...layer,
      mask: {
        kind: 'bitmap',
        recipe: {
          person: 2,
          facialSkin: false,
          bodySkin: true,
          model: 'vendor&co/<v2> "beta"',
          digest: '0123456789abcdef',
        },
        rasterId: 0,
      },
    };
    const block = localAdjustmentBlocks(withLayers([spiky]), CANONICAL_INDENT);
    expect(block).toContain('papp:MaskModel="vendor&amp;co/&lt;v2> &quot;beta&quot;"');
    expect(block).toContain('papp:MaskPerson="2"');
    expect(block).toContain('papp:MaskFacialSkin="False"');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments).toEqual([spiky]);
  });

  // ── Tolerant reader ──────────────────────────────────────────────────────

  it("drops Lightroom's own AI mask (Mask/Image with no papp: recipe) without erroring", () => {
    const doc = sidecar(
      groupCorrection(
        `${ACTIVE} crs:LocalExposure2012="1"`,
        '<rdf:li crs:What="Mask/Image" crs:MaskSubType="0" crs:MaskValue="1" crs:MaskDigest="lightroomownsubjectmaskdigest"/>',
      ),
    );
    const { model, passthrough } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([]);
    expect(passthrough.unknownNodes).toEqual([]);
  });

  it('drops a person/skin mask missing its digest rather than inventing one', () => {
    const doc = sidecar(
      groupCorrection(
        `${ACTIVE} crs:LocalExposure2012="1"`,
        '<rdf:li crs:What="Mask/Image" crs:MaskValue="1" papp:MaskSource="PersonSkin"/>',
      ),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  it("drops an inactive bitmap correction (Lightroom's disabled pin)", () => {
    const doc = sidecar(
      groupCorrection(
        'crs:What="Correction" crs:CorrectionActive="False" crs:LocalExposure2012="1"',
        '<rdf:li crs:What="Mask/Image" crs:MaskValue="1" papp:MaskSource="PersonSkin" papp:MaskDigest="deadbeefcafef00d"/>',
      ),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  it("uses raw-core's defaults for the recipe fields a hand-authored mask omits", () => {
    const doc = sidecar(
      groupCorrection(
        `${ACTIVE} crs:LocalHue="0.12"`,
        '<rdf:li crs:What="Mask/Image" crs:MaskValue="1" papp:MaskSource="PersonSkin" papp:MaskDigest="deadbeefcafef00d"/>',
      ),
    );
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([
      {
        mask: {
          kind: 'bitmap',
          recipe: {
            person: 0,
            facialSkin: true,
            bodySkin: true,
            model: '',
            digest: 'deadbeefcafef00d',
          },
          rasterId: 0,
        },
        adjustments: { hue: 12 },
      },
    ]);
  });

  it('never writes a raster id — a resolved layer re-serializes identically to an unresolved one', () => {
    const resolved: LocalAdjustment = {
      ...BITMAP_LAYER,
      mask: { ...BITMAP_LAYER.mask, rasterId: 7 } as LocalAdjustment['mask'],
    };
    expect(localAdjustmentBlocks(withLayers([resolved, EVERYWHERE_LAYER]), CANONICAL_INDENT)).toBe(
      CANONICAL_GROUP_BLOCK,
    );
  });

  it('still passes an unmodeled container (brush masks) through untouched', () => {
    const brush =
      '<crs:PaintBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction"/></rdf:li></rdf:Seq></crs:PaintBasedCorrections>';
    const original = serializer.serialize(withLayers([EVERYWHERE_LAYER]), {
      unknownAttributes: [],
      unknownNodes: [brush],
    });
    const { model, passthrough } = parser.parseAdjustmentModel(original);
    expect(model.localAdjustments).toEqual([EVERYWHERE_LAYER]);
    expect(passthrough.unknownNodes.join('')).toContain('crs:PaintBasedCorrections');
    // A re-save keeps both: the modeled group container regenerated from the
    // model, and the brush container carried verbatim (self-contained, so the
    // passthrough writer stamps its namespaces on it — the existing contract).
    const resaved = serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough);
    expect(resaved).toContain('papp:MaskSource="Everywhere"');
    expect(resaved).toContain('<crs:PaintBasedCorrections');
    expect(resaved).toContain('<rdf:Description crs:What="Correction"/>');
    expect(parser.parseAdjustmentModel(resaved).model.localAdjustments).toEqual([EVERYWHERE_LAYER]);
  });
});
