// xmp-variants.spec.ts — the TypeScript half of the byte contract for the
// variants / snapshots / history blocks (#2437).
//
// `VARIANTS_GOLDEN_DOCUMENT` below is the same literal as
// `xmpVariantsGoldenDocument` in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPVariantsTests.swift`,
// and `variantsFixture()` builds the same branching state as that file's
// `variantsFixture()`. Both suites assert their own writer reproduces the
// literal, so a divergence on either platform fails that platform's suite —
// the same zero-byte-diff discipline `xmp-canonical.spec.ts` already holds
// the document envelope to.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import {
  compactHistory,
  emptySidecarVariants,
  HISTORY_CAP,
  isValidVariantId,
  parseVariantSidecarName,
  PRIMARY_VARIANT_ID,
  variantSidecarName,
  type SidecarVariants,
} from './xmp-variants';

function snapshotModel(): AdjustmentModel {
  return {
    ...defaultAdjustmentModel(),
    profile: 'Neutral',
    brightness: 12,
    exposure: -0.25,
    crop: { top: 0.1, left: 0.2, bottom: 0.9, right: 0.8, angle: 0 },
  };
}

/** See the file header — mirrored by `variantsFixture()` in Swift. */
function variantsFixture(): SidecarVariants {
  return {
    variantId: '',
    variantName: '',
    variants: [
      { id: 'warm', name: 'Warm & tight', created: '2026-09-07T10:00:00Z', deleted: false },
      { id: 'bw', name: '', created: '2026-09-07T10:05:00Z', deleted: true },
    ],
    snapshots: [{ name: 'Before crop', created: '2026-09-07T10:01:00Z', model: snapshotModel() }],
    history: [
      {
        kind: 'adjustment',
        description: 'Brightness',
        time: '2026-09-07T10:01:00Z',
        model: { ...defaultAdjustmentModel(), brightness: 6 },
      },
      {
        kind: 'preset',
        description: 'Applied "Golden Hour"',
        time: '2026-09-07T10:02:00Z',
        model: { ...defaultAdjustmentModel(), filmLook: 'kodak-gold-200', filmStrength: 80 },
      },
      {
        kind: 'snapshot',
        description: 'Restored "Before crop"',
        time: '2026-09-07T10:03:00Z',
        model: snapshotModel(),
      },
    ],
  };
}

describe('variants, snapshots and history (#2437)', () => {
  let serializer: XmpSerializerService;
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    serializer = TestBed.inject(XmpSerializerService);
    parser = TestBed.inject(XmpParserService);
  });

  it('writes the shared fixture to the cross-engine golden, byte for byte', () => {
    const produced = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      variantsFixture(),
    );
    expect(produced).toBe(VARIANTS_GOLDEN_DOCUMENT);
  });

  it('adds nothing to a sidecar that never branched', () => {
    const bare = serializer.serialize(defaultAdjustmentModel());
    expect(serializer.serialize(defaultAdjustmentModel(), undefined, undefined, undefined)).toBe(
      bare,
    );
    expect(
      serializer.serialize(
        defaultAdjustmentModel(),
        undefined,
        undefined,
        undefined,
        emptySidecarVariants(),
      ),
    ).toBe(bare);
  });

  it('round-trips the three blocks', () => {
    const fixture = variantsFixture();
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      fixture,
    );
    const { variants } = parser.parseAdjustmentModel(xml);

    expect(variants.variants).toEqual(fixture.variants);
    expect(variants.snapshots.length).toBe(1);
    expect(variants.snapshots[0].name).toBe('Before crop');
    expect(variants.snapshots[0].created).toBe('2026-09-07T10:01:00Z');
    expect(variants.snapshots[0].model.brightness).toBe(12);
    expect(variants.snapshots[0].model.exposure).toBe(-0.25);
    expect(variants.snapshots[0].model.profile).toBe('Neutral');
    expect(variants.snapshots[0].model.crop).toEqual(snapshotModel().crop);

    expect(variants.history.map((h) => h.kind)).toEqual(['adjustment', 'preset', 'snapshot']);
    expect(variants.history[1].description).toBe('Applied "Golden Hour"');
    expect(variants.history[1].model.filmLook).toBe('kodak-gold-200');
    expect(variants.history[1].model.filmStrength).toBe(80);
    expect(variants.history[2].model.brightness).toBe(12);
  });

  it('is a fixed point across a read-modify-write', () => {
    const first = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      variantsFixture(),
    );
    const { model, passthrough, variants } = parser.parseAdjustmentModel(first);
    const second = serializer.serialize(
      { ...defaultAdjustmentModel(), ...model },
      passthrough,
      undefined,
      undefined,
      variants,
    );
    expect(second).toBe(first);
  });

  it('never lets an entry state reach the live image', () => {
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      variantsFixture(),
    );
    const { model } = parser.parseAdjustmentModel(xml);
    const live = { ...defaultAdjustmentModel(), ...model };
    expect(live.brightness).toBe(0);
    expect(live.exposure).toBe(0);
    expect(live.filmLook).toBe('');
    expect(live.crop).toEqual(defaultAdjustmentModel().crop);
  });

  it('keeps the blocks out of the passthrough bucket', () => {
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      variantsFixture(),
    );
    const { passthrough } = parser.parseAdjustmentModel(xml);
    const preserved = passthrough.unknownNodes.join('\n');
    expect(preserved).not.toContain('papp:Variants');
    expect(preserved).not.toContain('papp:Snapshots');
    expect(preserved).not.toContain('papp:History');
    expect(passthrough.unknownAttributes.map((a) => a.name)).not.toContain('papp:VariantId');
  });

  it('carries an entry point tone curve as a nested child', () => {
    const branching: SidecarVariants = {
      ...emptySidecarVariants(),
      history: [
        {
          kind: 'adjustment',
          description: 'Tone curve',
          time: '2026-09-07T11:00:00Z',
          model: {
            ...defaultAdjustmentModel(),
            toneCurveLuma: {
              points: [
                [0, 0],
                [0.5, 0.55],
                [1, 1],
              ],
            },
          },
        },
      ],
    };
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      branching,
    );
    expect(xml).toContain('<papp:SceneLinearToneCurve>');
    expect(xml).toContain('<rdf:li>127.5, 140.25</rdf:li>');

    const { model, variants } = parser.parseAdjustmentModel(xml);
    expect(model.toneCurveLuma).toBeUndefined();
    expect(variants.history[0].model.toneCurveLuma.points.length).toBe(3);
    expect(variants.history[0].model.toneCurveLuma.points[1][1]).toBeCloseTo(0.55, 5);
  });

  it('writes and reads a non-primary sidecar own identity', () => {
    const branching: SidecarVariants = {
      ...emptySidecarVariants(),
      variantId: 'warm',
      variantName: 'Warm',
    };
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      branching,
    );
    expect(xml).toContain('papp:VariantId="warm"');
    const { variants } = parser.parseAdjustmentModel(xml);
    expect(variants.variantId).toBe('warm');
    expect(variants.variantName).toBe('Warm');
  });

  it('drops a manifest entry whose id could not be a filename', () => {
    const xml = serializer
      .serialize(defaultAdjustmentModel())
      .replace(
        '/>\n  </rdf:RDF>',
        [
          '>',
          '      <papp:Variants>',
          '        <rdf:Seq>',
          '          <rdf:li>',
          '            <rdf:Description papp:VariantId="../escape"/>',
          '          </rdf:li>',
          '          <rdf:li>',
          '            <rdf:Description papp:VariantId="warm"/>',
          '          </rdf:li>',
          '        </rdf:Seq>',
          '      </papp:Variants>',
          '    </rdf:Description>',
          '  </rdf:RDF>',
        ].join('\n'),
      );
    const { variants } = parser.parseAdjustmentModel(xml);
    expect(variants.variants.map((v) => v.id)).toEqual(['warm']);
  });

  it('bounds history at the cap, oldest first', () => {
    const entries = Array.from({ length: HISTORY_CAP + 9 }, (_, i) => ({
      kind: 'adjustment',
      description: `Step ${i}`,
      time: '2026-09-07T10:00:00Z',
      model: defaultAdjustmentModel(),
    }));
    const compacted = compactHistory(entries);
    expect(compacted.length).toBe(HISTORY_CAP);
    expect(compacted[0].description).toBe('Step 9');
    expect(compacted[HISTORY_CAP - 1].description).toBe(`Step ${HISTORY_CAP + 8}`);
  });

  it('trims an over-long history on read', () => {
    const branching: SidecarVariants = {
      ...emptySidecarVariants(),
      history: Array.from({ length: HISTORY_CAP + 4 }, (_, i) => ({
        kind: 'adjustment',
        description: `Step ${i}`,
        time: '',
        model: defaultAdjustmentModel(),
      })),
    };
    const xml = serializer.serialize(
      defaultAdjustmentModel(),
      undefined,
      undefined,
      undefined,
      branching,
    );
    const { variants } = parser.parseAdjustmentModel(xml);
    expect(variants.history.length).toBe(HISTORY_CAP);
    expect(variants.history[0].description).toBe('Step 4');
  });

  it('constrains variant ids to filename-safe tokens', () => {
    expect(isValidVariantId('warm')).toBe(true);
    expect(isValidVariantId('v2')).toBe(true);
    expect(isValidVariantId('A-b_9')).toBe(true);
    expect(isValidVariantId('')).toBe(false);
    expect(isValidVariantId(PRIMARY_VARIANT_ID)).toBe(false);
    expect(isValidVariantId('with space')).toBe(false);
    expect(isValidVariantId('with.dot')).toBe(false);
    expect(isValidVariantId('with/slash')).toBe(false);
    expect(isValidVariantId('../escape')).toBe(false);
    expect(isValidVariantId('é')).toBe(false);
    expect(isValidVariantId('x'.repeat(33))).toBe(false);
  });

  it('maps a variant id onto a sibling sidecar filename', () => {
    expect(variantSidecarName('IMG_1234.xmp', 'warm')).toBe('IMG_1234.v-warm.xmp');
    // Videos append rather than swap, so the marker lands before `.xmp`
    // either way and the two naming rules stay independent.
    expect(variantSidecarName('clip.mov.xmp', 'warm')).toBe('clip.mov.v-warm.xmp');
    expect(variantSidecarName('IMG_1234.xmp', 'primary')).toBeNull();
    expect(variantSidecarName('IMG_1234.dng', 'warm')).toBeNull();

    expect(parseVariantSidecarName('IMG_1234.v-warm.xmp')).toEqual({
      primaryName: 'IMG_1234.xmp',
      id: 'warm',
    });
    expect(parseVariantSidecarName('clip.mov.v-warm.xmp')).toEqual({
      primaryName: 'clip.mov.xmp',
      id: 'warm',
    });
    expect(parseVariantSidecarName('IMG_1234.xmp')).toBeNull();
    expect(parseVariantSidecarName('IMG_1234.v-.xmp')).toBeNull();
    expect(parseVariantSidecarName('IMG_1234.v-a b.xmp')).toBeNull();
  });
});

/** See the file header — mirrored byte for byte by Swift's
 * `xmpVariantsGoldenDocument`. */
const VARIANTS_GOLDEN_DOCUMENT = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      crs:HasSettings="True"
      crs:ProcessVersion="11.0"
      crs:Version="11.0"
      papp:Profile="Auto">
      <papp:Variants>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              papp:VariantCreated="2026-09-07T10:00:00Z"
              papp:VariantId="warm"
              papp:VariantName="Warm &amp; tight"/>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              papp:VariantCreated="2026-09-07T10:05:00Z"
              papp:VariantDeleted="True"
              papp:VariantId="bw"/>
          </rdf:li>
        </rdf:Seq>
      </papp:Variants>
      <papp:Snapshots>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:CropBottom="0.900000"
              crs:CropConstrainToWarp="0"
              crs:CropLeft="0.200000"
              crs:CropRight="0.800000"
              crs:CropTop="0.100000"
              crs:Exposure2012="-0.25"
              crs:HasCrop="True"
              papp:Brightness="12"
              papp:Profile="Neutral"
              papp:SnapshotCreated="2026-09-07T10:01:00Z"
              papp:SnapshotName="Before crop"/>
          </rdf:li>
        </rdf:Seq>
      </papp:Snapshots>
      <papp:History>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              papp:Brightness="6"
              papp:HistoryDescription="Brightness"
              papp:HistoryKind="adjustment"
              papp:HistoryTime="2026-09-07T10:01:00Z"
              papp:Profile="Auto"/>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              papp:FilmLook="kodak-gold-200"
              papp:FilmStrength="80"
              papp:HistoryDescription="Applied &quot;Golden Hour&quot;"
              papp:HistoryKind="preset"
              papp:HistoryTime="2026-09-07T10:02:00Z"
              papp:Profile="Auto"/>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              crs:CropBottom="0.900000"
              crs:CropConstrainToWarp="0"
              crs:CropLeft="0.200000"
              crs:CropRight="0.800000"
              crs:CropTop="0.100000"
              crs:Exposure2012="-0.25"
              crs:HasCrop="True"
              papp:Brightness="12"
              papp:HistoryDescription="Restored &quot;Before crop&quot;"
              papp:HistoryKind="snapshot"
              papp:HistoryTime="2026-09-07T10:03:00Z"
              papp:Profile="Neutral"/>
          </rdf:li>
        </rdf:Seq>
      </papp:History>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
