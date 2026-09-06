import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStateService } from './editor-state.service';
import { makeLibraryStub, type LibraryStub } from './editor-state.test-helpers';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import {
  WHITE_BALANCE_PRESETS,
  WHITE_BALANCE_PRESET_VALUES,
  AUTO_WB_ALGORITHM_VERSION,
} from '../generated/white-balance-presets.generated';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';

const ID = 'asset-1';
const recommendation: AutoAdjustPatch = {
  exposure: -1,
  temperature: 5800,
  tint: 5,
  contrast: 99,
  highlights: -20,
  shadows: 30,
  whites: 40,
  blacks: -50,
};

describe('authorable WB modes (#3307)', () => {
  let editor: EditorStateService;
  let library: LibraryStub;
  const compute = vi.fn<() => Promise<AutoAdjustPatch>>();

  beforeEach(() => {
    library = makeLibraryStub();
    library.primeBytes(ID, new Uint8Array([1]));
    compute.mockReset().mockResolvedValue(recommendation);
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: library },
        { provide: RawPipelineService, useValue: { computeAutoAdjustments: compute } },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.bind(ID);
  });

  it('a global temperature nudge replaces AUTO provenance and is undoable', async () => {
    await editor.applyWhiteBalancePreset(ID, 'Auto');
    const auto = library.adjustmentFor(ID)();
    editor.commit();
    editor.armTool('temp');
    editor.setArmedDisplayValue(6000);
    editor.endEdit();
    const manual = library.adjustmentFor(ID)();
    expect(manual).toMatchObject({
      temperature: 6000,
      tint: auto.tint,
      whiteBalancePreset: 'Custom',
      wbSource: 'Manual',
      wbSampleX: 0,
      wbSampleY: 0,
      wbAlgorithmVersion: 0,
    });
    const xml = TestBed.inject(XmpSerializerService).serialize(manual);
    expect(TestBed.inject(XmpParserService).parseAdjustmentModel(xml).model).toMatchObject({
      whiteBalancePreset: 'Custom',
      wbSource: 'Manual',
    });
    expect(xml).not.toContain('papp:WbAlgorithmVersion');
    editor.undo();
    expect(library.adjustmentFor(ID)()).toEqual(auto);
  });

  for (const preset of WHITE_BALANCE_PRESETS.filter((name) => WHITE_BALANCE_PRESET_VALUES[name])) {
    it(`${preset} writes its canonical pair, round-trips and undoes as one action`, async () => {
      library.updateAdjustment(ID, {
        exposure: 2,
        wbScaleVersion: 1,
        wbSource: 'Sampled',
        wbSampleX: 0.4,
        wbSampleY: 0.7,
        wbAlgorithmVersion: 9,
      });
      const before = library.adjustmentFor(ID)();
      expect(await editor.applyWhiteBalancePreset(ID, preset)).toBe(true);
      const applied = library.adjustmentFor(ID)();
      expect(applied).toMatchObject({
        ...WHITE_BALANCE_PRESET_VALUES[preset],
        whiteBalancePreset: preset,
        wbScaleVersion: 5,
        wbSource: 'Preset',
        wbSampleX: 0,
        wbSampleY: 0,
        wbAlgorithmVersion: 0,
        exposure: 2,
      });
      const xml = TestBed.inject(XmpSerializerService).serialize(applied);
      expect(TestBed.inject(XmpParserService).parseAdjustmentModel(xml).model).toMatchObject({
        ...WHITE_BALANCE_PRESET_VALUES[preset],
        whiteBalancePreset: preset,
        wbSource: 'Preset',
        wbScaleVersion: 5,
      });
      expect(editor.undoHistory()).toHaveLength(1);
      editor.undo();
      expect(library.adjustmentFor(ID)()).toEqual(before);
      editor.redo();
      expect(library.adjustmentFor(ID)()).toEqual(applied);
    });
  }

  it('Custom preserves legacy numbers; As Shot uses this camera’s reading', async () => {
    library.updateAdjustment(ID, { temperature: 5100, tint: -8, wbScaleVersion: 1 });
    await editor.applyWhiteBalancePreset(ID, 'Custom');
    expect(library.adjustmentFor(ID)()).toMatchObject({
      temperature: 5100,
      tint: -8,
      wbScaleVersion: 1,
      wbSource: 'Manual',
    });
    expect(await editor.applyWhiteBalancePreset(ID, 'As Shot')).toBe(false);
    library.setAsShot(ID, { temperature: 5300, tint: 6 });
    await editor.applyWhiteBalancePreset(ID, 'As Shot');
    expect(library.adjustmentFor(ID)()).toMatchObject({
      temperature: 5300,
      tint: 6,
      wbScaleVersion: 5,
      whiteBalancePreset: 'As Shot',
      wbSource: 'AsShot',
    });
  });

  it('WB Auto preserves tone/AE and records version, with one undo', async () => {
    library.updateAdjustment(ID, { exposure: 2, contrast: 13, wbScaleVersion: 1 });
    const before = library.adjustmentFor(ID)();
    expect(await editor.applyWhiteBalancePreset(ID, 'Auto')).toBe(true);
    expect(library.adjustmentFor(ID)()).toMatchObject({
      temperature: 5800,
      tint: 5,
      exposure: 2,
      contrast: 13,
      autoExposure: before.autoExposure,
      wbScaleVersion: 5,
      wbSource: 'Auto',
      whiteBalancePreset: 'Auto',
      wbAlgorithmVersion: AUTO_WB_ALGORITHM_VERSION,
    });
    editor.undo();
    expect(library.adjustmentFor(ID)()).toEqual(before);
    expect(editor.canUndo()).toBe(false);
  });

  it.each([false, true])(
    'discards a delayed result after a newer edit (undone: %s)',
    async (undo) => {
      let resolve!: (value: AutoAdjustPatch) => void;
      compute.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = editor.applyAuto(ID);
      editor.commit('adjustment', 'Manual exposure');
      library.updateAdjustment(ID, { exposure: 2 });
      editor.endEdit();
      if (undo) editor.undo();
      const expected = library.adjustmentFor(ID)();
      const history = editor.undoHistory();
      resolve(recommendation);
      expect(await pending).toBe(false);
      expect(library.adjustmentFor(ID)()).toEqual(expected);
      expect(editor.undoHistory()).toEqual(history);
      expect(editor.canRedo()).toBe(undo);
    },
  );

  it('does not overlap AUTO and neutral sampling', async () => {
    editor.wbSampleInFlight.set(true);
    expect(await editor.applyAuto(ID)).toBe(false);
    expect(compute).not.toHaveBeenCalled();
    editor.wbSampleInFlight.set(false);
    editor.autoInFlight.set(true);
    expect(await editor.sampleWhiteBalanceAt(ID, 0.5, 0.5)).toBe(false);
    expect(editor.canUndo()).toBe(false);
  });

  it('rejects nonfinite analysis without changing model or undo', async () => {
    compute.mockResolvedValue({ ...recommendation, tint: Number.NaN });
    const before = library.adjustmentFor(ID)();
    expect(await editor.applyAuto(ID)).toBe(false);
    expect(library.adjustmentFor(ID)()).toEqual(before);
    expect(editor.canUndo()).toBe(false);
  });

  it('an unchanged recommendation preserves redo', async () => {
    await editor.applyAuto(ID);
    editor.commit('adjustment', 'Manual exposure');
    library.updateAdjustment(ID, { exposure: 2 });
    editor.endEdit();
    editor.undo();
    expect(await editor.applyAuto(ID)).toBe(false);
    expect(editor.canRedo()).toBe(true);
  });
});
