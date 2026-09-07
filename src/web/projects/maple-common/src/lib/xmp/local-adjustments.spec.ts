// local-adjustments.spec.ts — nested-element XMP I/O for local adjustments
// (#358): the canonical `crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` containers.
//
// `CANONICAL_BLOCK` below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_local_adjustments.rs`),
// the Swift suite (`LocalAdjustmentXMPTests.swift`) and the C# suite
// (`XmpLocalAdjustmentsTests.cs`), and all four serializers must produce it
// byte-for-byte from the same two-layer model at the same indent — the same
// contract `point-tone-curve.spec.ts` pins for the tone curves.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, LocalAdjustment } from '../models/adjustment-model';

/** Six spaces — the canonical depth for children of `rdf:Description`. */
const CANONICAL_INDENT = '      ';

/** The linear half of the shared fixture (`linear_layer()` in Rust). */
const LINEAR_LAYER: LocalAdjustment = {
  mask: { kind: 'linear', start: { x: 0.2, y: 0.3 }, end: { x: 0.8, y: 0.7 }, feather: 0.4 },
  adjustments: { exposure: 0.5, shadows: -20, hue: -35 },
  range: {
    kind: 'color',
    hueDeg: 55,
    hueHalfWidthDeg: 25,
    chromaMin: 0.02,
    lMin: 0.15,
    lMax: 0.95,
    feather: 0.3,
  },
};

/**
 * The radial half (`radial_layer()` in Rust). Binary-exact fractions so the
 * wire form's `center ± radii` bounding box round-trips to bit-identical
 * doubles; the angle is built with the same expression the parser uses.
 */
const RADIAL_LAYER: LocalAdjustment = {
  mask: {
    kind: 'radial',
    center: { x: 0.5, y: 0.375 },
    radii: { x: 0.25, y: 0.125 },
    angle: (45 * Math.PI) / 180,
    feather: 0.6,
    invert: true,
  },
  adjustments: { contrast: 15, vibrance: -10, temperature: 200, hue: 0 },
  range: {
    kind: 'color',
    hueDeg: 210,
    hueHalfWidthDeg: 40,
    chromaMin: 0.1,
    lMin: 0,
    lMax: 1,
    feather: 0,
  },
};

/** Cross-language byte-parity fixture — see the file header. */
const CANONICAL_BLOCK = [
  '      <crs:GradientBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalExposure2012="0.5"',
  '              crs:LocalShadows2012="-20"',
  '              crs:LocalHue="-0.35"',
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
  '                    crs:What="Mask/Gradient"',
  '                    crs:MaskValue="1"',
  '                    crs:ZeroX="0.2" crs:ZeroY="0.3"',
  '                    crs:FullX="0.8" crs:FullY="0.7"',
  '                    papp:LocalFeather="0.4"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:GradientBasedCorrections>',
  '      <crs:CircularGradientBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalContrast2012="15"',
  '              papp:LocalVibrance="-10"',
  '              crs:LocalTemperature="200"',
  '              crs:LocalHue="0"',
  '              papp:RangeKind="Color"',
  '              papp:RangeHue="210"',
  '              papp:RangeHueWidth="40"',
  '              papp:RangeChromaMin="0.1"',
  '              papp:RangeLMin="0"',
  '              papp:RangeLMax="1"',
  '              papp:RangeFeather="0">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/CircularGradient"',
  '                    crs:MaskValue="1"',
  '                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.5" crs:Right="0.75"',
  '                    crs:Angle="45" crs:Midpoint="50" crs:Roundness="0"',
  '                    crs:Feather="60" crs:Flipped="True"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:CircularGradientBasedCorrections>',
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

/** One gradient correction with the given description attributes and mask leaf. */
function gradientCorrection(descriptionAttrs: string, maskLeaf: string): string {
  return [
    '      <crs:GradientBasedCorrections>',
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
    '      </crs:GradientBasedCorrections>',
  ].join('\n');
}

const FULL_FRAME_GRADIENT =
  '<rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0"/>';

describe('XMP local adjustments (#358)', () => {
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

  it('serializes the canonical block from a hand-built model', () => {
    expect(localAdjustmentBlocks(withLayers([LINEAR_LAYER, RADIAL_LAYER]), CANONICAL_INDENT)).toBe(
      CANONICAL_BLOCK,
    );
  });

  it('parses the canonical block back into the fixture layers', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(model.localAdjustments).toEqual([LINEAR_LAYER, RADIAL_LAYER]);
  });

  it('round-trips the canonical block byte-for-byte', () => {
    const { model } = parser.parseAdjustmentModel(sidecar(CANONICAL_BLOCK));
    expect(localAdjustmentBlocks(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  // ── Whole-document behaviour ─────────────────────────────────────────────

  it('rides the model, not the passthrough bucket, and re-saves as a fixed point', () => {
    const original = serializer.serialize(withLayers([LINEAR_LAYER, RADIAL_LAYER]));
    expect(original).toContain(CANONICAL_BLOCK);

    const { model, passthrough } = parser.parseAdjustmentModel(original);
    expect(passthrough.unknownNodes).toEqual([]);
    expect(model.localAdjustments).toEqual([LINEAR_LAYER, RADIAL_LAYER]);

    const resaved = serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough);
    expect(resaved).toBe(original);
  });

  it('emits nothing for an empty stack — identity is silence', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('GradientBasedCorrections');
    expect(xml).not.toContain('</rdf:Description>');
    expect(localAdjustmentBlocks(defaultAdjustmentModel(), CANONICAL_INDENT)).toBe('');
  });

  it('writes an interleaved stack as two contiguous runs, linear first', () => {
    const block = localAdjustmentBlocks(
      withLayers([RADIAL_LAYER, LINEAR_LAYER, RADIAL_LAYER]),
      CANONICAL_INDENT,
    );
    const gradient = block.indexOf('<crs:GradientBasedCorrections>');
    const circular = block.indexOf('<crs:CircularGradientBasedCorrections>');
    expect(gradient).toBeGreaterThanOrEqual(0);
    expect(circular).toBeGreaterThan(gradient);
    expect(block.match(/crs:What="Mask\/CircularGradient"/g)).toHaveLength(2);
  });

  it('round-trips through a real .xmp file in a temp directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maple-xmp-358-'));
    try {
      const path = join(dir, 'photo.xmp');
      writeFileSync(path, serializer.serialize(withLayers([LINEAR_LAYER, RADIAL_LAYER])), 'utf8');

      const { model, passthrough } = parser.parseAdjustmentModel(readFileSync(path, 'utf8'));
      expect(model.localAdjustments).toEqual([LINEAR_LAYER, RADIAL_LAYER]);

      const original = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough),
        'utf8',
      );
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Tolerant reader ──────────────────────────────────────────────────────

  it('drops a correction whose mask kind Maple does not model', () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:CorrectionActive="True" crs:LocalExposure2012="1"',
        '<rdf:li crs:What="Mask/Brush" crs:MaskValue="1"/>',
      ),
    );
    const { model, passthrough } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([]);
    expect(passthrough.unknownNodes).toEqual([]);
  });

  it("drops an inactive correction (Lightroom's disabled pin)", () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:CorrectionActive="False" crs:LocalExposure2012="2"',
        FULL_FRAME_GRADIENT,
      ),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  it('scales every slider by crs:CorrectionAmount at parse time', () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:CorrectionAmount="0.5" crs:LocalExposure2012="2" crs:LocalContrast2012="-40"',
        FULL_FRAME_GRADIENT,
      ),
    );
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments?.[0].adjustments).toEqual({ exposure: 1, contrast: -20 });
  });

  it('scales hue by Amount without changing the color selection', () => {
    const { model } = parser.parseAdjustmentModel(
      sidecar(CANONICAL_BLOCK.replaceAll('crs:CorrectionAmount="1"', 'crs:CorrectionAmount="0.5"')),
    );
    expect(model.localAdjustments?.[0].adjustments.hue).toBe(-17.5);
    expect(model.localAdjustments?.[1].adjustments.hue).toBe(0);
    expect(model.localAdjustments?.map((layer) => layer.range)).toEqual([
      LINEAR_LAYER.range,
      RADIAL_LAYER.range,
    ]);
  });

  it('accepts remapped and legacy namespace prefixes for hue and all range fields', () => {
    for (const uri of ['http://ns.justmaple.app/photo/1.0/', 'http://ns.justmaple.app/1.0/']) {
      const xml = sidecar(CANONICAL_BLOCK)
        .replaceAll('http://ns.justmaple.app/photo/1.0/', uri)
        .replaceAll('crs:', 'camera:')
        .replaceAll('xmlns:crs=', 'xmlns:camera=')
        .replaceAll('papp:', 'maple:')
        .replaceAll('xmlns:papp=', 'xmlns:maple=');
      expect(parser.parseAdjustmentModel(xml).model.localAdjustments).toEqual([
        LINEAR_LAYER,
        RADIAL_LAYER,
      ]);
    }
  });

  it('uses core defaults for missing Color coordinates and preserves explicit zero', () => {
    const { model } = parser.parseAdjustmentModel(
      sidecar(
        gradientCorrection(
          'crs:LocalHue="0" papp:RangeKind="Color" papp:RangeHue="0" papp:RangeFeather="0"',
          FULL_FRAME_GRADIENT,
        ),
      ),
    );
    expect(model.localAdjustments?.[0].range).toEqual({
      ...LINEAR_LAYER.range,
      hueDeg: 0,
      feather: 0,
    });
    expect(model.localAdjustments?.[0].adjustments).toEqual({ hue: 0 });
  });

  it.each(['', 'papp:RangeKind="Future"', 'papp:RangeKind="Color" papp:RangeHue="NaN"'])(
    'keeps absent, unknown and corrupt ranges absent: %s',
    (attrs) => {
      const { model } = parser.parseAdjustmentModel(
        sidecar(gradientCorrection(`crs:LocalHue="NaN" ${attrs}`, FULL_FRAME_GRADIENT)),
      );
      expect(model.localAdjustments?.[0].range).toBeUndefined();
      expect(model.localAdjustments?.[0].adjustments).toEqual({});
      expect(localAdjustmentBlocks(model, CANONICAL_INDENT)).not.toMatch(/RangeKind|LocalHue/);
    },
  );

  it('drops a mask missing its required geometry rather than inventing a default', () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:LocalExposure2012="1"',
        '<rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroY="0" crs:FullX="1" crs:FullY="1"/>',
      ),
    );
    expect(parser.parseAdjustmentModel(doc).model.localAdjustments).toEqual([]);
  });

  it('accepts a non-self-closing mask leaf and case-insensitive booleans', () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:CorrectionActive="on" crs:LocalExposure2012="0.5"',
        '<rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.1" crs:ZeroY="0.2" crs:FullX="0.9" crs:FullY="0.8"></rdf:li>',
      ),
    );
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([
      {
        mask: {
          kind: 'linear',
          start: { x: 0.1, y: 0.2 },
          end: { x: 0.9, y: 0.8 },
          feather: 0.5,
        },
        adjustments: { exposure: 0.5 },
      },
    ]);
  });

  it('imports a Lightroom-authored radial correction, ignoring the attributes Maple has no field for', () => {
    const doc = sidecar(
      [
        '      <crs:CircularGradientBasedCorrections>',
        '        <rdf:Seq>',
        '          <rdf:li>',
        '            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true"',
        '              crs:LocalSaturation="-15" crs:LocalClarity2012="20" crs:LocalTemperature="-50">',
        '              <crs:CorrectionMasks>',
        '                <rdf:Seq>',
        '                  <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1"',
        '                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.5" crs:Right="0.75"',
        '                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="20" crs:Feather="50" crs:Flipped="false"',
        '                    crs:MaskName="Radial Gradient 1" crs:MaskSyncID="ABC"/>',
        '                </rdf:Seq>',
        '              </crs:CorrectionMasks>',
        '            </rdf:Description>',
        '          </rdf:li>',
        '        </rdf:Seq>',
        '      </crs:CircularGradientBasedCorrections>',
      ].join('\n'),
    );
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments).toEqual([
      {
        mask: {
          kind: 'radial',
          center: { x: 0.5, y: 0.375 },
          radii: { x: 0.25, y: 0.125 },
          angle: 0,
          feather: 0.5,
          invert: false,
        },
        adjustments: { saturation: -15, temperature: -50 },
      },
    ]);
  });
});
