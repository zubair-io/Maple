// local-adjustments.test-helpers.ts — the shared fixtures behind the two
// local-adjustment XMP suites: `local-adjustments.spec.ts` (containers,
// tolerant reader, cross-language byte parity) and
// `local-adjustments-spatial.spec.ts` (the six #3407 spatial controls).
//
// Same split raw-core makes — `tests_local_adjustments.rs` owns the helpers,
// `tests_local_adjustments_canonical.rs` and `..._spatial.rs` import them —
// so one fixture backs every assertion and no suite outgrows the file budget.
//
// `CANONICAL_BLOCK` is the cross-language parity artifact: the same literal
// appears in the Rust suite (`raw-core/src/xmp/tests_local_adjustments_canonical.rs`),
// the Swift suite (`LocalAdjustmentXMPTests.swift`) and the C# suite
// (`XmpLocalAdjustmentsTests.cs`), and all four serializers must produce it
// byte-for-byte from the same two-layer model at the same indent — the same
// contract `point-tone-curve.spec.ts` pins for the tone curves.

import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel, LocalAdjustment } from '../models/adjustment-model';

/** A model carrying exactly `layers`, everything else at its default. */
export const withLayers = (layers: LocalAdjustment[]): AdjustmentModel => ({
  ...defaultAdjustmentModel(),
  localAdjustments: layers,
});

/** Six spaces — the canonical depth for children of `rdf:Description`. */
export const CANONICAL_INDENT = '      ';

/** The linear half of the shared fixture (`linear_layer()` in Rust). */
export const LINEAR_LAYER: LocalAdjustment = {
  mask: { kind: 'linear', start: { x: 0.2, y: 0.3 }, end: { x: 0.8, y: 0.7 }, feather: 0.4 },
  // Fractional hue on purpose: pins the four-decimal `crs:LocalHue` wire
  // precision across all four writers (two decimals would drift it).
  adjustments: { exposure: 0.5, shadows: -20, hue: -42.5 },
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
export const RADIAL_LAYER: LocalAdjustment = {
  mask: {
    kind: 'radial',
    center: { x: 0.5, y: 0.375 },
    radii: { x: 0.25, y: 0.125 },
    angle: (45 * Math.PI) / 180,
    feather: 0.6,
    invert: true,
  },
  // The six spatial controls (#3407), all non-default so the four-writer
  // byte-parity golden pins their keys, their Adobe ±1 fraction scale and
  // their emission order. `clarity: 35` is the ticket's own Lightroom
  // example, which stores as `crs:LocalClarity2012="0.35"`.
  adjustments: {
    contrast: 15,
    vibrance: -10,
    temperature: 200,
    hue: 0,
    texture: 18,
    clarity: 35,
    dehaze: -22.5,
    sharpness: 66,
    luminanceNoise: 40,
    defringe: 75,
  },
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
export const CANONICAL_BLOCK = [
  '      <crs:GradientBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              crs:LocalExposure2012="0.5"',
  '              crs:LocalShadows2012="-20"',
  '              crs:LocalHue="-0.425"',
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
  '              crs:LocalTexture="0.18"',
  '              crs:LocalClarity2012="0.35"',
  '              crs:LocalDehaze="-0.225"',
  '              crs:LocalSharpness="0.66"',
  '              crs:LocalLuminanceNoise="0.4"',
  '              crs:LocalDefringe="0.75"',
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
export function sidecar(children: string): string {
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
export function gradientCorrection(descriptionAttrs: string, maskLeaf: string): string {
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

/** The six #3407 attribute names, in emission order. */
export const SPATIAL_KEYS = [
  'crs:LocalTexture',
  'crs:LocalClarity2012',
  'crs:LocalDehaze',
  'crs:LocalSharpness',
  'crs:LocalLuminanceNoise',
  'crs:LocalDefringe',
];

export const FULL_FRAME_GRADIENT =
  '<rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0"/>';
