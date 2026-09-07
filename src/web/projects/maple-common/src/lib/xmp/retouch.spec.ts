// retouch.spec.ts — `crs:RetouchAreas` round trips (#3409).
//
// CANONICAL_BLOCK below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_retouch.rs`),
// the Swift suite (`RetouchXMPTests.swift`) and the C# suite
// (`XmpRetouchTests.cs`), and every writer that models the block must
// produce it byte for byte from `canonicalSpots()`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { retouchAreasBlock } from './xmp-retouch';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { RetouchSpot } from '../models/retouch-spot';

/** Six spaces — the canonical `rdf:Description` child indent. */
const CANONICAL_INDENT = '      ';

/** Mirrored by `canonical_spots()` in Rust and `canonicalSpots()` in Swift. */
function canonicalSpots(): RetouchSpot[] {
  return [
    {
      kind: 'heal',
      center: { x: 0.25, y: 0.5 },
      source: { x: 0.75, y: 0.5 },
      radius: 0.05,
      feather: 0.5,
      opacity: 1,
    },
    {
      kind: 'clone',
      center: { x: 0.8, y: 0.2 },
      source: { x: 0.6, y: 0.3 },
      radius: 0.0125,
      feather: 0,
      opacity: 0.75,
    },
  ];
}

const CANONICAL_BLOCK = `      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:SpotType="heal"
              crs:SourceState="sourceSetExplicitly"
              crs:Method="circle"
              crs:SourceX="0.750000"
              crs:SourceY="0.500000"
              crs:Opacity="1.000000"
              crs:Feather="0.500000"
              crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:X="0.250000"
                    crs:Y="0.500000"
                    crs:Radius="0.050000"
                    crs:Flow="1"
                    crs:CenterWeight="0"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              crs:SpotType="clone"
              crs:SourceState="sourceSetExplicitly"
              crs:Method="circle"
              crs:SourceX="0.600000"
              crs:SourceY="0.300000"
              crs:Opacity="0.750000"
              crs:Feather="0.000000"
              crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:X="0.800000"
                    crs:Y="0.200000"
                    crs:Radius="0.012500"
                    crs:Flow="1"
                    crs:CenterWeight="0"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>`;

/** Wrap a child block in the minimum envelope the parser accepts. */
const document = (children: string): string =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Version="11.0">
${children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe('crs:RetouchAreas (#3409)', () => {
  let serializer: XmpSerializerService;
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    serializer = TestBed.inject(XmpSerializerService);
    parser = TestBed.inject(XmpParserService);
  });

  it('emits nothing for a model with no spots', () => {
    expect(retouchAreasBlock(defaultAdjustmentModel(), CANONICAL_INDENT)).toBe('');
    expect(serializer.serialize(defaultAdjustmentModel())).not.toContain('RetouchAreas');
  });

  it('serializes the cross-language canonical block, byte for byte', () => {
    expect(retouchAreasBlock({ retouchSpots: canonicalSpots() }, CANONICAL_INDENT)).toBe(
      CANONICAL_BLOCK,
    );
  });

  it('round-trips the canonical block through parse → serialize', () => {
    const { model } = parser.parseAdjustmentModel(document(CANONICAL_BLOCK));
    expect(model.retouchSpots).toEqual(canonicalSpots());
    expect(retouchAreasBlock(model, CANONICAL_INDENT)).toBe(CANONICAL_BLOCK);
  });

  it('rides the model, not the passthrough bucket', () => {
    const { passthrough } = parser.parseAdjustmentModel(document(CANONICAL_BLOCK));
    const preserved = (passthrough?.unknownNodes ?? []).join('');
    expect(preserved).not.toContain('RetouchAreas');
  });

  it('writes the container exactly once through a full sidecar round trip', () => {
    const { model, passthrough } = parser.parseAdjustmentModel(document(CANONICAL_BLOCK));
    const resaved = serializer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough);
    expect(resaved.split('<crs:RetouchAreas>').length - 1).toBe(1);
    expect(resaved).toContain(CANONICAL_BLOCK);
  });

  it('imports a spot whose source is encoded as an offset', () => {
    const block = `      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:SpotType="heal" crs:SourceState="sourceAutoComputed"
              crs:OffsetX="0.100000" crs:OffsetY="-0.050000" crs:Feather="0.250000">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1"
                    crs:X="0.400000" crs:Y="0.600000" crs:Radius="0.030000"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>`;
    const { model } = parser.parseAdjustmentModel(document(block));
    expect(model.retouchSpots?.length).toBe(1);
    expect(model.retouchSpots![0].source.x).toBeCloseTo(0.5, 6);
    expect(model.retouchSpots![0].source.y).toBeCloseTo(0.55, 6);
    expect(model.retouchSpots![0].feather).toBeCloseTo(0.25, 6);
  });

  it('drops a correction whose mask is not the circular form', () => {
    const block = `      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:SpotType="heal" crs:SourceX="0.1" crs:SourceY="0.1">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Radius="0.02"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>`;
    const { model } = parser.parseAdjustmentModel(document(block));
    expect(model.retouchSpots ?? []).toEqual([]);
  });

  it('reads the legacy crs:RetouchInfo string form', () => {
    const block = `      <crs:RetouchInfo>
        <rdf:Seq>
          <rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.02, sourceState = sourceSetExplicitly, sourceX = 0.6, sourceY = 0.5, spotType = heal</rdf:li>
        </rdf:Seq>
      </crs:RetouchInfo>`;
    const { model } = parser.parseAdjustmentModel(document(block));
    expect(model.retouchSpots?.length).toBe(1);
    expect(model.retouchSpots![0].kind).toBe('heal');
    expect(model.retouchSpots![0].radius).toBeCloseTo(0.02, 6);
  });

  it('prefers the struct form over the legacy strings', () => {
    const legacy = `      <crs:RetouchInfo>
        <rdf:Seq>
          <rdf:li>centerX = 0.9, centerY = 0.9, radius = 0.5, sourceState = sourceSetExplicitly, sourceX = 0.1, sourceY = 0.1, spotType = clone</rdf:li>
        </rdf:Seq>
      </crs:RetouchInfo>`;
    const { model } = parser.parseAdjustmentModel(document(`${legacy}\n${CANONICAL_BLOCK}`));
    expect(model.retouchSpots).toEqual(canonicalSpots());
  });
});
