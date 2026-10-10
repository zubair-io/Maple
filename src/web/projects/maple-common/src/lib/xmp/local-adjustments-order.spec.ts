// local-adjustments-order.spec.ts — cross-container layer order (#4427):
// `papp:LayerOrder` keeps an interleaved stack in model order through the
// per-kind XMP containers. Mirrors raw-core's
// `tests_local_adjustments_order.rs`; `CANONICAL_ORDER_BLOCK` is the shared
// cross-language literal (also in `LocalAdjustmentOrderTests.swift` and
// `XmpLayerOrderTests.cs`).

import '@angular/compiler';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { LocalAdjustment } from '../models/adjustment-model';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { planLayerOrder } from './xmp-verbatim-layer-order';
import { CANONICAL_INDENT, sidecar, withLayers } from './local-adjustments.test-helpers';

const parser = new XmpParserService();
const writer = new XmpSerializerService();

const linear = (exposure: number): LocalAdjustment => ({
  mask: { kind: 'linear', start: { x: 0.2, y: 0.3 }, end: { x: 0.8, y: 0.7 }, feather: 0.5 },
  adjustments: { exposure },
});

const radial = (exposure: number): LocalAdjustment => ({
  mask: {
    kind: 'radial',
    center: { x: 0.5, y: 0.5 },
    radii: { x: 0.25, y: 0.125 },
    angle: 0,
    feather: 0.5,
    invert: false,
  },
  adjustments: { exposure },
});

const brush = (exposure: number): LocalAdjustment => ({
  mask: {
    kind: 'brush',
    dabs: [{ center: { x: 0.25, y: 0.3 }, radius: 0.05, feather: 0.5, weight: 0.8, erase: false }],
    digest: '0123456789abcdef',
    rasterId: 0,
  },
  adjustments: { exposure },
});

const bitmap = (exposure: number): LocalAdjustment => ({
  mask: {
    kind: 'bitmap',
    recipe: {
      person: 0,
      facialSkin: true,
      bodySkin: false,
      model: 'apple-vision-person-instance/1',
      digest: 'a1b2c3d4e5f60718',
    },
    rasterId: 0,
  },
  adjustments: { exposure },
});

const everywhere = (exposure: number): LocalAdjustment => ({
  mask: { kind: 'everywhere' },
  adjustments: { exposure },
});

const interleavedStack = (): LocalAdjustment[] => [
  brush(0.1),
  radial(0.2),
  bitmap(0.3),
  linear(0.4),
  radial(0.5),
];

const CANONICAL_ORDER_BLOCK = [
  '      <crs:GradientBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              papp:LayerOrder="1"',
  '              crs:LocalExposure2012="0.4">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Gradient"',
  '                    crs:MaskValue="1"',
  '                    crs:ZeroX="0.2" crs:ZeroY="0.3"',
  '                    crs:FullX="0.8" crs:FullY="0.7"',
  '                    papp:LocalFeather="0.5"/>',
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
  '              papp:LayerOrder="0"',
  '              crs:LocalExposure2012="0.2">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/CircularGradient"',
  '                    crs:MaskValue="1"',
  '                    crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"',
  '                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"',
  '                    crs:Feather="50" crs:Flipped="False"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:CircularGradientBasedCorrections>',
].join('\n');

const BRUSH_V2_BLOCK = [
  '      <papp:BrushCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              papp:LayerOrder="1"',
  '              crs:LocalExposure2012="0.3">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Paint"',
  '                    crs:MaskValue="1"',
  '                    papp:BrushVersion="2"',
  '                    papp:Dabs="0.25 0.3 0.05 0.5 0.8 0"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </papp:BrushCorrections>',
].join('\n');

const PASSTHROUGH_ORDER_BLOCK = [
  '      <crs:GradientBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              papp:LayerOrder="-1"',
  '              crs:LocalExposure2012="0.1">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Gradient"',
  '                    crs:MaskValue="1"',
  '                    crs:ZeroX="0.2" crs:ZeroY="0.3"',
  '                    crs:FullX="0.8" crs:FullY="0.7"',
  '                    papp:LocalFeather="0.5"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '          <rdf:li>',
  '            <rdf:Description',
  '              crs:What="Correction"',
  '              crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True"',
  '              papp:LayerOrder="0"',
  '              crs:LocalExposure2012="0.4">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/Gradient"',
  '                    crs:MaskValue="1"',
  '                    crs:ZeroX="0.2" crs:ZeroY="0.3"',
  '                    crs:FullX="0.8" crs:FullY="0.7"',
  '                    papp:LocalFeather="0.5"/>',
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
  '              papp:LayerOrder="2"',
  '              crs:LocalExposure2012="0.2">',
  '              <crs:CorrectionMasks>',
  '                <rdf:Seq>',
  '                  <rdf:li',
  '                    crs:What="Mask/CircularGradient"',
  '                    crs:MaskValue="1"',
  '                    crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"',
  '                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"',
  '                    crs:Feather="50" crs:Flipped="False"/>',
  '                </rdf:Seq>',
  '              </crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:CircularGradientBasedCorrections>',
].join('\n');

const FOREIGN_GROUP = [
  '      <crs:MaskGroupBasedCorrections>',
  '        <rdf:Seq>',
  '          <rdf:li>',
  '            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1"',
  '              crs:CorrectionActive="True" crs:LocalExposure2012="1">',
  '              <crs:CorrectionMasks><rdf:Seq>',
  '                <rdf:li crs:What="Mask/Image" crs:MaskDigest="lightroom-ai" crs:MaskSubType="0"/>',
  '              </rdf:Seq></crs:CorrectionMasks>',
  '            </rdf:Description>',
  '          </rdf:li>',
  '        </rdf:Seq>',
  '      </crs:MaskGroupBasedCorrections>',
].join('\n');

/** Write `xml` to a real `.xmp` file, read it back, and re-save it through the parser. */
function reopenAndResave(
  xml: string,
  edit: (layers: LocalAdjustment[]) => LocalAdjustment[] = (layers) => layers,
): { reopened: LocalAdjustment[]; resaved: string } {
  const directory = mkdtempSync(join(tmpdir(), 'maple-xmp-4427-'));
  try {
    const path = join(directory, 'photo.xmp');
    writeFileSync(path, xml, 'utf8');
    const { model, passthrough } = parser.parseAdjustmentModel(readFileSync(path, 'utf8'));
    const reopened = model.localAdjustments ?? [];
    const resaved = writer.serialize(
      { ...defaultAdjustmentModel(), ...model, localAdjustments: edit(reopened) },
      passthrough,
    );
    writeFileSync(path, resaved, 'utf8');
    return { reopened, resaved: readFileSync(path, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const withoutGroupSlot = (layers: LocalAdjustment[]): LocalAdjustment[] =>
  layers.map(({ xmpGroupSlot: _slot, ...layer }) => layer);

const withoutReadOrder = (layers: LocalAdjustment[]): LocalAdjustment[] =>
  layers.map(({ xmpLayerOrder: _order, ...layer }) => layer);

/** Linear (key 0) and radial (key 2) around the unreadable stroke (key 1). */
const PASSTHROUGH_SOURCE = sidecar(
  CANONICAL_ORDER_BLOCK.replace('papp:LayerOrder="0"', 'papp:LayerOrder="2"').replace(
    'papp:LayerOrder="1"',
    'papp:LayerOrder="0"',
  ) +
    '\n' +
    BRUSH_V2_BLOCK,
);

/** Web's verbatim form of the stroke container: its re-serialized source, never edited. */
const verbatimStroke = (): string =>
  parser.parseAdjustmentModel(sidecar(BRUSH_V2_BLOCK)).passthrough.unknownNodes[0];

/** Linear (key 0) and radial (key 2) around a keyed opaque Lightroom correction (key 1). */
const TEMPLATE_SOURCE = sidecar(
  CANONICAL_ORDER_BLOCK.replace('papp:LayerOrder="0"', 'papp:LayerOrder="2"').replace(
    'papp:LayerOrder="1"',
    'papp:LayerOrder="0"',
  ) +
    '\n' +
    FOREIGN_GROUP.replace(
      'crs:LocalExposure2012="1">',
      'crs:LocalExposure2012="1" papp:LayerOrder="1">',
    ),
);

const writtenKeys = (xml: string): string[] =>
  Array.from(xml.matchAll(/papp:LayerOrder="([^"]*)"/g), (match) => match[1]);

describe('XMP local adjustments — cross-container layer order (#4427)', () => {
  it('serializes an interleaved pair to the cross-language literal and parses it back', () => {
    const layers = [radial(0.2), linear(0.4)];
    expect(localAdjustmentBlocks(withLayers(layers), CANONICAL_INDENT)).toBe(CANONICAL_ORDER_BLOCK);
    expect(
      parser.parseAdjustmentModel(sidecar(CANONICAL_ORDER_BLOCK)).model.localAdjustments,
    ).toEqual(layers);
  });

  it('keeps an interleaved stack in model order through save, reopen, save', () => {
    const first = writer.serialize(withLayers(interleavedStack()));
    expect(first.match(/papp:LayerOrder=/g)).toHaveLength(5);
    const { reopened, resaved } = reopenAndResave(first);
    expect(reopened).toEqual(interleavedStack());
    expect(resaved).toBe(first);
  });

  it('writes no order keys when the stack is already in container order', () => {
    const ordered = [linear(0.4), radial(0.2), brush(0.1), bitmap(0.3)];
    const saved = writer.serialize(withLayers(ordered));
    expect(saved).not.toContain('papp:LayerOrder');
    expect(parser.parseAdjustmentModel(saved).model.localAdjustments).toEqual(ordered);
  });

  it('loads an unkeyed sidecar in container order and re-saves it byte-identically', () => {
    const unkeyed = writer
      .serialize(withLayers(interleavedStack()))
      .split('\n')
      .filter((line) => !line.includes('papp:LayerOrder='))
      .join('\n');
    const { reopened, resaved } = reopenAndResave(unkeyed);
    expect(reopened).toEqual([linear(0.4), radial(0.2), radial(0.5), brush(0.1), bitmap(0.3)]);
    expect(resaved).toBe(unkeyed);
  });

  it.each([
    ['missing', ''],
    ['non-finite', '              papp:LayerOrder="Infinity"\n'],
    ['non-numeric', '              papp:LayerOrder="first"\n'],
  ])('loads a sidecar whose second key is %s in container order', (_name, replacement) => {
    const saved = writer.serialize(withLayers([radial(0.2), linear(0.4)]));
    const partial = saved.replace('              papp:LayerOrder="1"\n', replacement);
    expect(partial).not.toBe(saved);
    expect(parser.parseAdjustmentModel(partial).model.localAdjustments).toEqual([
      linear(0.4),
      radial(0.2),
    ]);
  });

  it('keys group corrections re-emitted through a foreign mask-group template', () => {
    const authored = [everywhere(0.3), linear(0.4)];
    const { resaved: first } = reopenAndResave(sidecar(FOREIGN_GROUP), () => authored);
    expect(first).toContain('crs:MaskDigest="lightroom-ai"');
    expect(first.match(/papp:LayerOrder=/g)).toHaveLength(2);
    const { reopened, resaved } = reopenAndResave(first);
    expect(withoutGroupSlot(reopened)).toEqual(authored);
    expect(reopened.some((layer) => layer.xmpMetadata)).toBe(false);
    expect(resaved).toBe(first);
  });

  it('keys a layer inserted at the bottom below every existing key', () => {
    const { reopened: loaded } = reopenAndResave(PASSTHROUGH_SOURCE);
    expect(withoutReadOrder(loaded)).toEqual([linear(0.4), radial(0.2)]);
    expect(loaded.map((layer) => layer.xmpLayerOrder)).toEqual([0, 2]);

    const { resaved: first } = reopenAndResave(PASSTHROUGH_SOURCE, (layers) => [
      linear(0.1),
      ...layers,
    ]);
    expect(first).toContain(PASSTHROUGH_ORDER_BLOCK);
    expect(first).toContain(verbatimStroke());

    const { reopened, resaved } = reopenAndResave(first);
    expect(withoutReadOrder(reopened)).toEqual([linear(0.1), linear(0.4), radial(0.2)]);
    expect(resaved).toBe(first);
  });

  it('writes identical bytes when saving twice without reopening', () => {
    const { model, passthrough } = parser.parseAdjustmentModel(PASSTHROUGH_SOURCE);
    const edited = {
      ...defaultAdjustmentModel(),
      ...model,
      localAdjustments: [linear(0.1), ...(model.localAdjustments ?? [])],
    };
    const first = writer.serialize(edited, passthrough);
    expect(first).toContain(PASSTHROUGH_ORDER_BLOCK);
    expect(writer.serialize(edited, passthrough)).toBe(first);
  });

  it('leaves every surviving key alone when a layer is deleted', () => {
    const { resaved: first } = reopenAndResave(PASSTHROUGH_SOURCE, (layers) => layers.slice(1));
    expect(first).toContain(verbatimStroke());
    expect(writtenKeys(first)).toEqual(['2', '1']);

    const { reopened, resaved } = reopenAndResave(first);
    expect(withoutReadOrder(reopened)).toEqual([radial(0.2)]);
    expect(reopened[0].xmpLayerOrder).toBe(2);
    expect(resaved).toBe(first);
  });

  it('formats a key between two neighbours with six decimals', () => {
    const { resaved } = reopenAndResave(PASSTHROUGH_SOURCE, ([below, above]) => [
      below,
      radial(0.7),
      above,
    ]);
    expect(writtenKeys(resaved)).toEqual(['0', '0.5', '2', '1']);
    const { reopened } = reopenAndResave(resaved);
    expect(withoutReadOrder(reopened)).toEqual([linear(0.4), radial(0.7), radial(0.2)]);
  });

  it('keeps no read keys when nothing is kept verbatim', () => {
    const { reopened } = reopenAndResave(sidecar(CANONICAL_ORDER_BLOCK));
    expect(reopened.every((layer) => !('xmpLayerOrder' in layer))).toBe(true);
  });

  it('keeps a keyed opaque mask-group correction in place inside its template', () => {
    const { resaved: inserted } = reopenAndResave(TEMPLATE_SOURCE, (layers) => [
      linear(0.1),
      ...layers,
    ]);
    expect(inserted).toContain('crs:MaskDigest="lightroom-ai"');
    expect(writtenKeys(inserted)).toEqual(['-1', '0', '2', '1']);
    expect(reopenAndResave(inserted).resaved).toBe(inserted);

    const { resaved: deleted } = reopenAndResave(TEMPLATE_SOURCE, (layers) => layers.slice(1));
    expect(writtenKeys(deleted)).toEqual(['2', '1']);
    const { reopened, resaved } = reopenAndResave(deleted);
    expect(withoutReadOrder(reopened)).toEqual([radial(0.2)]);
    expect(resaved).toBe(deleted);
  });

  it('keeps the later layer when two read keys swap places', () => {
    const above = { ...radial(0.2), xmpLayerOrder: 2 };
    const below = { ...linear(0.4), xmpLayerOrder: 0 };
    const orderOf = planLayerOrder([above, below], [1]);
    expect([orderOf(above), orderOf(below)]).toEqual([-1, 0]);
  });

  it('re-spaces keys the six-decimal codec would collapse (25 layers appended on top)', () => {
    const keyedLinear = CANONICAL_ORDER_BLOCK.split('\n      <crs:CircularGradient')[0].replace(
      'papp:LayerOrder="1"',
      'papp:LayerOrder="0"',
    );
    const source = sidecar(`${keyedLinear}\n${BRUSH_V2_BLOCK}`);
    const appended = Array.from({ length: 25 }, () => linear(0.1));
    const { resaved: first } = reopenAndResave(source, (layers) => [...layers, ...appended]);
    const expected = Array.from({ length: 26 }, (_, index) => String(index - 25));
    expect(writtenKeys(first)).toEqual([...expected, '1']);

    const { reopened, resaved } = reopenAndResave(first);
    expect(withoutReadOrder(reopened)).toEqual([linear(0.4), ...appended]);
    expect(resaved).toBe(first);
  });

  it('reads a verbatim key whose papp namespace is bound to another prefix', () => {
    const aliased = TEMPLATE_SOURCE.replace(
      'papp:LayerOrder="1">',
      'xmlns:maple="http://ns.justmaple.app/photo/1.0/" maple:LayerOrder="1">',
    );
    expect(aliased).not.toBe(TEMPLATE_SOURCE);
    const { resaved } = reopenAndResave(aliased, (layers) => [linear(0.1), ...layers]);
    expect(writtenKeys(resaved)).toEqual(['-1', '0', '2']);
    expect(resaved).toContain('maple:LayerOrder="1"');
    expect(reopenAndResave(resaved).resaved).toBe(resaved);
  });
});
