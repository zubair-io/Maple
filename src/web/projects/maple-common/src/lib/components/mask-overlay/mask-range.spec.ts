// The mask panel's colour-range refinement (#362): the session's enable /
// slider / eyedropper writes and their undo boundaries, and the pure
// transforms behind them.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { MaskSessionService } from './mask-session.service';
import { defaultRangeRefinement, displayHue, seededRange, withRangeField } from './mask-range';
import { rangeSampleRejectionText, seededLayer } from './mask-range-sample';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { RangeSampleRejected } from '../../raw-pipeline/raw-pipeline.sample-range.types';
import { makeLibraryStub, type LibraryStub } from '../../editor/editor-state.test-helpers';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

const SEED = { hueDeg: 210, chromaMin: 0.05, lMin: 0.1, lMax: 0.6 };

describe('mask range transforms (#362)', () => {
  it('a seed moves the colour selection and never the width or feather', () => {
    const base = { ...defaultRangeRefinement(), hueHalfWidthDeg: 40, feather: 0.7 };
    expect(seededRange(base, SEED)).toEqual({
      kind: 'color',
      hueDeg: 210,
      hueHalfWidthDeg: 40,
      chromaMin: 0.05,
      lMin: 0.1,
      lMax: 0.6,
      feather: 0.7,
    });
  });

  it('a slider write moves one coordinate only', () => {
    const next = withRangeField(defaultRangeRefinement(), 'lMax', 0.5);
    expect(next.lMax).toBe(0.5);
    expect({ ...next, lMax: 0.95 }).toEqual(defaultRangeRefinement());
  });

  it('an eyedropper pick enables a range on a layer that had none', () => {
    const layer = { mask: { kind: 'everywhere' } as const, adjustments: {} };
    expect(seededLayer(layer, SEED).range).toEqual(seededRange(defaultRangeRefinement(), SEED));
  });

  it('reads the wire hue back onto a 0–360 wheel', () => {
    expect(displayHue(55)).toBe(55);
    expect(displayHue(-120)).toBe(240);
    expect(displayHue(180)).toBe(180);
  });

  it('names what to pick instead for every rejection kind', () => {
    expect(rangeSampleRejectionText(new RangeSampleRejected('neutral', 'x'))).toContain('coloured');
    expect(rangeSampleRejectionText(new RangeSampleRejected('too_dark', 'x'))).toContain(
      'brighter',
    );
    expect(rangeSampleRejectionText(new RangeSampleRejected('outside_image', 'x'))).toContain(
      'inside',
    );
    expect(rangeSampleRejectionText(new Error('worker unavailable'))).toBe(
      'The colour could not be sampled',
    );
  });
});

describe('MaskSessionService colour range (#362)', () => {
  let lib: LibraryStub & { focusedAsset: ReturnType<typeof signal> };
  let editor: EditorStateService;
  let session: MaskSessionService;
  let sampleMaskRange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const stub = makeLibraryStub();
    lib = Object.assign(stub, {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    }) as typeof lib;
    sampleMaskRange = vi.fn().mockResolvedValue(SEED);
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: { sampleMaskRange } },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.imageId.set('asset-1');
    session = TestBed.inject(MaskSessionService);
    lib.primeBytes('asset-1', new Uint8Array([1, 2, 3]));
  });

  const layers = () => lib.adjustmentFor('asset-1')().localAdjustments ?? [];
  /** The single layer these cases add — throwing beats a silent undefined. */
  const layer0 = () => {
    const [layer] = layers();
    if (!layer) throw new Error('expected one mask layer');
    return layer;
  };

  it('the toggle arms raw-core defaults and drops them again, one entry each way', () => {
    session.addLinear();
    expect(session.range()).toBeNull();
    session.setRangeEnabled(true);
    expect(session.range()).toEqual(defaultRangeRefinement());
    // A redundant enable writes nothing.
    const undoDepth = editor.canUndo();
    session.setRangeEnabled(true);
    expect(editor.canUndo()).toBe(undoDepth);
    session.setRangeEnabled(false);
    expect(layer0().range).toBeUndefined();
    editor.undo();
    expect(layer0().range).toEqual(defaultRangeRefinement());
  });

  it('a slider drag is one undo entry however many samples it writes', () => {
    session.addLinear();
    session.setRangeEnabled(true);
    const armed = layer0().range;
    session.beginGesture();
    session.setRangeField('hueHalfWidthDeg', 30);
    session.setRangeField('hueHalfWidthDeg', 35);
    session.setRangeField('feather', 0.5);
    session.endGesture();
    expect(session.rangeValue('hueHalfWidthDeg')).toBe(35);
    expect(session.rangeValue('feather')).toBe(0.5);
    expect(session.range()?.hueDeg).toBe(55);
    editor.undo();
    expect(layer0().range).toEqual(armed);
  });

  it('a slider write on a layer without a range is ignored', () => {
    session.addLinear();
    session.setRangeField('lMax', 0.5);
    expect(layer0().range).toBeUndefined();
  });

  it('the eyedropper seeds the selected layer as one undo entry', async () => {
    session.addRadial();
    const before = layer0();
    await expect(session.sampleRangeAt(0.25, 0.75)).resolves.toBe(true);
    expect(sampleMaskRange).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'dng',
      expect.stringContaining('<x:xmpmeta'),
      0.25,
      0.75,
    );
    expect(layer0().range).toEqual(seededRange(defaultRangeRefinement(), SEED));
    editor.undo();
    expect(layer0()).toEqual(before);
  });

  it('a rejected pick leaves the model untouched and explains why', async () => {
    session.addLinear();
    session.setRangeEnabled(true);
    const armed = layer0().range;
    sampleMaskRange.mockRejectedValueOnce(new RangeSampleRejected('neutral', 'x'));
    await expect(session.sampleRangeAt(0.5, 0.5)).resolves.toBe(false);
    expect(layer0().range).toEqual(armed);
    expect(session.rangeMessage()).toContain('coloured');
  });

  it('refuses to sample with no layer selected — there is nothing to seed', async () => {
    await expect(session.sampleRangeAt(0.5, 0.5)).resolves.toBe(false);
    expect(sampleMaskRange).not.toHaveBeenCalled();
  });
});

describe('a panel-authored range on the wire (#362)', () => {
  let serializer: XmpSerializerService;
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    serializer = TestBed.inject(XmpSerializerService);
    parser = TestBed.inject(XmpParserService);
  });

  /** What the eyedropper then the sliders leave on the selected layer. */
  const authored = () =>
    withRangeField(
      seededRange(defaultRangeRefinement(), {
        hueDeg: -123.45,
        chromaMin: 0.07,
        lMin: 0.31,
        lMax: 0.81,
      }),
      'feather',
      0,
    );

  const withRange = (range: ReturnType<typeof authored> | undefined) => ({
    ...defaultAdjustmentModel(),
    localAdjustments: [
      {
        mask: {
          kind: 'linear' as const,
          start: { x: 0.1, y: 0.2 },
          end: { x: 0.9, y: 0.8 },
          feather: 0.5,
        },
        adjustments: { exposure: 0.5 },
        range,
      },
    ],
  });

  it('serialises to the exact papp:Range* attributes and reads back identical', () => {
    const range = authored();
    const xml = serializer.serialize(withRange(range));
    for (const line of [
      'papp:RangeKind="Color"',
      'papp:RangeHue="-123.45"',
      'papp:RangeHueWidth="25"',
      'papp:RangeChromaMin="0.07"',
      'papp:RangeLMin="0.31"',
      'papp:RangeLMax="0.81"',
      'papp:RangeFeather="0"',
    ]) {
      expect(xml).toContain(line);
    }
    const reopened = parser.parseAdjustmentModel(xml).model.localAdjustments ?? [];
    expect(reopened.map((layer) => layer.range)).toEqual([range]);
  });

  it('a disabled range emits no papp:Range attribute at all', () => {
    expect(serializer.serialize(withRange(undefined))).not.toContain('papp:Range');
  });
});
