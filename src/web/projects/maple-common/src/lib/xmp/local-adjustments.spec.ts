// local-adjustments.spec.ts — nested-element XMP I/O for local adjustments
// (#358): the canonical `crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` containers, plus the tolerant
// reader's drop rules. The fixtures — including the cross-language
// `CANONICAL_BLOCK` — live in `./local-adjustments.test-helpers`, shared with
// `local-adjustments-spatial.spec.ts` (#3407).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { LocalAdjustment } from '../models/adjustment-model';
import {
  CANONICAL_BLOCK,
  CANONICAL_INDENT,
  FULL_FRAME_GRADIENT,
  LINEAR_LAYER,
  RADIAL_LAYER,
  gradientCorrection,
  sidecar,
  withLayers,
} from './local-adjustments.test-helpers';

describe('XMP local adjustments (#358)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
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
    expect(model.localAdjustments?.[0].adjustments.hue).toBe(-21.25);
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
        '              crs:LocalSaturation="-15" crs:LocalClarity2012="0.2" crs:LocalTemperature="-50"',
        '              crs:LocalMoire="30" crs:LocalGrain="0.4">',
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
        // Clarity IS a Maple field now (#3407) and lifts off Adobe's ±1
        // fraction scale; Moire and Grain still have no local twin and drop.
        adjustments: { saturation: -15, clarity: 20, temperature: -50 },
      },
    ]);
  });

  it('writes crs:LocalHue at four decimals so a fractional hue survives the Adobe-scale round trip', () => {
    // −42.5 on the ±100 slider is −0.425 on Adobe's ±1 wire scale; the
    // canonical two-decimal codec would persist "-0.43" and read back −43.
    const layer: LocalAdjustment = { ...LINEAR_LAYER, adjustments: { hue: -42.5 } };
    const block = localAdjustmentBlocks(withLayers([layer]), CANONICAL_INDENT);
    expect(block).toContain('crs:LocalHue="-0.425"');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments?.[0].adjustments).toEqual({ hue: -42.5 });
  });
});
