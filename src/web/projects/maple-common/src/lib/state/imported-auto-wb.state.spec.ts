// Name-only imported Auto WB (#4669) through the real store and editor: the pair
// lands in the background, so nothing the user does (or undoes, or reloads)
// may turn it back into As Shot or into a user edit.
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import {
  hydratePartialWhiteBalance,
  withResolvedImportedAuto,
} from '../models/partial-white-balance';
import { canUseLiveFastPath } from '../components/image-canvas/image-canvas.live-params';
import { sampleMaskRangeInto } from '../components/mask-overlay/mask-range-sample';
import { EditorStateService } from '../editor/editor-state.service';
import { makeLibraryStub, type LibraryStub } from '../editor/editor-state.test-helpers';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';
import type { MaskRangeSeed } from '../raw-pipeline/raw-pipeline.sample-range.types';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { LibraryStateService } from './library-state.service';
import { LibraryStore } from './library-store.service';

const nameOnly =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>';
const parser = new XmpParserService();
const serializer = new XmpSerializerService();
const parsed = (): Partial<AdjustmentModel> => parser.parseAdjustmentModel(nameOnly).model;
const asShot = { temperature: 5200, tint: 4 };
const pair = { temperature: 7148.669, tint: 12.18 };
/** The store model after the first frame seeded As Shot, before the estimate. */
const opened = (): AdjustmentModel =>
  hydratePartialWhiteBalance(
    { ...defaultAdjustmentModel(), ...parsed() },
    asShot.temperature,
    asShot.tint,
    true,
  );
/** The probe's authored temperature, or NaN when the XMP names Auto without numbers. */
const authoredTemperature = (xmp: string): number =>
  Number(/crs:Temperature="([-\d.]+)"/.exec(xmp)?.[1] ?? NaN);

describe('imported Auto pair in the real LibraryStore (#4669)', () => {
  let store: LibraryStore;
  const id = 'lib:a.dng';
  beforeEach(() => {
    TestBed.resetTestingModule();
    store = TestBed.inject(LibraryStore);
    store.restoreAdjustment(id, parsed());
    store.seedAsShotWhiteBalance(id, asShot.temperature, asShot.tint, true);
    store.resolveImportedAutoWhiteBalance(id, pair);
  });
  const shown = () => store.adjustmentFor(id)();

  it('keeps the pair when a delayed persisted base merges in', () => {
    store.mergePersistedAdjustment(id, { ...parsed(), exposure: 0.5 }, {});
    expect([shown().temperature, shown().tint, shown().exposure]).toEqual([
      pair.temperature,
      pair.tint,
      0.5,
    ]);
    expect(shown().partialWhiteBalance?.resolved).toEqual(pair);
    expect(serializer.serialize(shown())).not.toMatch(/crs:(Temperature|Tint)=/);
  });

  it('keeps the pair when Undo replays a snapshot taken before it landed', () => {
    store.setAdjustment(id, structuredClone(opened()));
    expect([shown().temperature, shown().tint]).toEqual([pair.temperature, pair.tint]);
  });

  it('gives the Before/After baseline the pair', () => {
    const baseline = store.hydrateAdjustment(id, { ...defaultAdjustmentModel(), ...parsed() });
    expect([baseline.temperature, baseline.tint]).toEqual([pair.temperature, pair.tint]);
  });

  it('still lets a numeric WB edit replace the import, never re-estimated', () => {
    store.setAdjustment(id, { temperature: 4000 });
    expect(shown().partialWhiteBalance).toBeNull();
    expect(shown().temperature).toBe(4000);
    store.mergePersistedAdjustment(id, {}, {});
    expect(shown().temperature).toBe(4000);
  });
});

describe('imported Auto pair landing in the real EditorStateService (#4669)', () => {
  const ID = 'asset-1';
  let lib: LibraryStub;
  let editor: EditorStateService;
  let autoPatch: () => Promise<AutoAdjustPatch>;
  const sampled: string[] = [];
  beforeEach(() => {
    TestBed.resetTestingModule();
    lib = makeLibraryStub();
    lib.primeBytes(ID, new Uint8Array([1, 2, 3]));
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        {
          provide: RawPipelineService,
          useValue: {
            computeAutoAdjustments: () => autoPatch(),
            sampleWhiteBalance: async (_b: Uint8Array, _e: string, xmp: string) => {
              sampled.push(xmp);
              return { temperature: 5000, tint: 0 };
            },
          },
        },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.bind(ID);
    lib.updateAdjustment(ID, opened());
  });
  /** The background resolve writes the pair to the store's model, as the canvas does. */
  const land = () => lib.updateAdjustment(ID, withResolvedImportedAuto(opened(), pair));

  it('records no Undo entry and no write when the pair lands inside a transaction', () => {
    editor.commit('adjustment', 'Exposure');
    land();
    expect(editor.canUndo()).toBe(false);
    const writes = lib.updateCount;
    editor.endEdit();
    expect(editor.undoHistory()).toHaveLength(0);
    expect(lib.updateCount).toBe(writes);
  });

  it('a real edit in that transaction undoes to the resolved pair, not As Shot', () => {
    editor.commit('adjustment', 'Exposure');
    land();
    lib.updateAdjustment(ID, { exposure: 1 });
    editor.endEdit();
    expect(editor.undoHistory()).toHaveLength(1);
    editor.undo();
    const undone = lib.adjustmentFor(ID)();
    expect([undone.temperature, undone.tint, undone.exposure]).toEqual([
      pair.temperature,
      pair.tint,
      0,
    ]);
  });

  it('applies Auto clicked while the estimate was running', async () => {
    autoPatch = async () => {
      land();
      return {
        exposure: 0.25,
        temperature: 5800,
        tint: 5,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
      };
    };
    expect(await editor.applyAuto(ID)).toBe(true);
    expect(lib.adjustmentFor(ID)().temperature).toBe(5800);
  });

  it('samples WB against the resolved pair the canvas painted', async () => {
    land();
    sampled.length = 0;
    await editor.sampleWhiteBalanceAt(ID, 0.5, 0.5);
    expect(authoredTemperature(sampled[0])).toBeCloseTo(pair.temperature, 0);
  });

  it('samples a mask colour range against the resolved pair', async () => {
    const xmps: string[] = [];
    await sampleMaskRangeInto(
      {
        focusedAssetId: () => ID,
        currentAdjustment: () => withResolvedImportedAuto(opened(), pair),
        assetExtension: () => 'dng',
        bytes: async () => new Uint8Array(),
        serialize: (model) => serializer.serialize(model),
        sampleMaskRange: async (_b, _e, xmp) => {
          xmps.push(xmp);
          return {} as MaskRangeSeed;
        },
        applySeed: vi.fn(),
        setMessage: vi.fn(),
      },
      0.5,
      0.5,
    );
    expect(authoredTemperature(xmps[0])).toBeCloseTo(pair.temperature, 0);
  });

  it('keeps the scalar fast path once the pair has landed', () => {
    const resolved = { ...withResolvedImportedAuto(opened(), pair), sharpenAmount: 0, nrColor: 0 };
    expect(canUseLiveFastPath({ ...opened(), sharpenAmount: 0, nrColor: 0 })).toBe(false);
    expect(canUseLiveFastPath(resolved)).toBe(true);
  });
});
