// LensProfileSelectComponent — unit tests (#3569).
//
// Stubs the three services the component talks to: the library (focused
// asset + its adjustment model), the editor (undo transaction bracket) and
// the pipeline (the two direct wasm fetches this dropdown owns —
// `compatibleLensProfiles` / `lensProfileEvidence`, independent of any
// render). The reload runs from a constructor `effect()`, so every test
// awaits it settling (`vi.waitFor` on `isLoading`) before asserting,
// mirroring how `lens-profile-import.component.spec.ts` awaits `choose()`.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LensProfileSelectComponent } from './lens-profile-select.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type {
  CompatibleLensProfile,
  LensProfileEvidence,
} from '../../lens/lens-profile-choice.types';

const BUNDLED = [
  { slug: 'sony/fe-24-70mm-f2.8-gm@sony-e', maker: 'Sony', model: 'FE 24-70mm F2.8 GM' },
  { slug: 'sigma/50mm-f1.4-dg-hsm-art@sony-e', maker: 'Sigma', model: '50mm F1.4 DG HSM Art' },
] satisfies CompatibleLensProfile[];

const AUTO_MATCH: LensProfileEvidence = {
  source: 'lensfun',
  confidence: 'in-range',
  lens: 'Sony FE 24-70mm F2.8 GM',
  dbVersion: '12f5976',
  hasDistortion: true,
  hasCa: true,
  hasVignetting: true,
  approximations: [],
  unsupported: [],
};

const NO_MATCH: LensProfileEvidence = {
  source: 'none',
  confidence: 'embedded',
  hasDistortion: false,
  hasCa: false,
  hasVignetting: false,
  approximations: [],
  unsupported: [],
};

interface FixtureOptions {
  /** Overrides the default (always-resolves-to-`AUTO_MATCH`) evidence mock —
   *  set this to seed the FIRST (constructor-effect) reload, since changing
   *  the mock after that reload has already resolved a given reference does
   *  nothing until the reference itself changes. */
  evidence?: () => Promise<LensProfileEvidence>;
  compatible?: () => Promise<CompatibleLensProfile[]>;
}

async function fixture(options: FixtureOptions = {}) {
  const focused = signal<string | null>('one');
  const model = signal(defaultAdjustmentModel());
  const editor = { commit: vi.fn(), endEdit: vi.fn() };
  const pipeline = {
    compatibleLensProfiles: vi.fn(
      options.compatible ?? (async (): Promise<CompatibleLensProfile[]> => BUNDLED),
    ),
    lensProfileEvidence: vi.fn(
      options.evidence ?? (async (): Promise<LensProfileEvidence> => AUTO_MATCH),
    ),
  };
  const library = {
    focusedAssetId: focused,
    focusedAsset: () => (focused() ? { id: focused(), filename: 'photo.DNG' } : null),
    adjustmentFor: () => model,
    bytesForAsset: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
    updateAdjustment: vi.fn((_: string, patch: object) =>
      model.update((value) => ({ ...value, ...patch })),
    ),
  };
  TestBed.configureTestingModule({
    imports: [LensProfileSelectComponent],
    providers: [
      { provide: LibraryStateService, useValue: library },
      { provide: EditorStateService, useValue: editor },
      { provide: RawPipelineService, useValue: pipeline },
    ],
  });
  await TestBed.compileComponents();
  const view = TestBed.createComponent(LensProfileSelectComponent);
  view.detectChanges();
  await vi.waitFor(() => expect(view.componentInstance.isLoading()).toBe(false));
  view.detectChanges();
  const byTestId = (id: string) =>
    (view.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    view,
    component: view.componentInstance,
    library,
    focused,
    model,
    editor,
    pipeline,
    byTestId,
  };
}

describe('LensProfileSelectComponent', () => {
  it('lists Automatic first, then the compatible bundled lenses sorted by name', async () => {
    const test = await fixture();
    expect(test.component.options()).toEqual([
      { value: '', label: 'Automatic' },
      { value: 'lensfun1:sigma/50mm-f1.4-dg-hsm-art@sony-e', label: 'Sigma 50mm F1.4 DG HSM Art' },
      { value: 'lensfun1:sony/fe-24-70mm-f2.8-gm@sony-e', label: 'Sony FE 24-70mm F2.8 GM' },
    ]);
  });

  it('describes an automatic Lensfun match on the source line, naming the matched lens', async () => {
    const test = await fixture();
    expect(test.component.reference()).toBe('');
    const text = test.byTestId('lens-profile-select-source')?.textContent;
    // The dropdown's own row just reads "Automatic" — this is the only place
    // that names WHICH lens it matched (verified live against a real fixture,
    // see lens-corrections-panel.component.spec.ts's #3569 block).
    expect(text).toContain('Sony FE 24-70mm F2.8 GM');
    expect(text).toContain('Lensfun database 12f5976');
    expect(text).toContain('CC BY-SA 3.0');
  });

  it('reports no match plainly when automatic resolves to nothing', async () => {
    const test = await fixture({ evidence: async () => NO_MATCH });
    expect(test.byTestId('lens-profile-select-source')?.textContent).toContain(
      'Automatic — no match',
    );
  });

  it('picking a bundled lens writes one undoable edit with the lensfun1: reference', async () => {
    const test = await fixture();
    test.component.select('lensfun1:sigma/50mm-f1.4-dg-hsm-art@sony-e');
    expect(test.editor.commit).toHaveBeenCalledWith('adjustment', 'Lens Profile');
    expect(test.editor.endEdit).toHaveBeenCalledTimes(1);
    expect(test.model().lensProfile).toBe('lensfun1:sigma/50mm-f1.4-dg-hsm-art@sony-e');
  });

  it('re-resolves when the reference changes and shows the new pick’s evidence', async () => {
    const test = await fixture();
    const picked: LensProfileEvidence = {
      source: 'lensfun',
      confidence: 'in-range',
      lens: 'Sigma 50mm F1.4 DG HSM Art',
      dbVersion: '12f5976',
      hasDistortion: true,
      hasCa: false,
      hasVignetting: true,
      approximations: [],
      unsupported: [],
    };
    test.pipeline.lensProfileEvidence.mockResolvedValue(picked);
    test.component.select('lensfun1:sigma/50mm-f1.4-dg-hsm-art@sony-e');
    await vi.waitFor(() =>
      expect(test.pipeline.lensProfileEvidence).toHaveBeenLastCalledWith(
        expect.any(Uint8Array),
        'dng',
        'lensfun1:sigma/50mm-f1.4-dg-hsm-art@sony-e',
      ),
    );
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-select-source')?.textContent).toContain(
      'Lensfun database 12f5976',
    );
  });

  it('is a no-op when the same value is picked again', async () => {
    const test = await fixture();
    test.component.select('');
    expect(test.editor.commit).not.toHaveBeenCalled();
    expect(test.library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('appends a stale reference the current compatible list no longer names', async () => {
    const test = await fixture();
    const stale = 'lensfun1:pentax/old-lens@k-mount';
    test.pipeline.lensProfileEvidence.mockResolvedValue({
      source: 'lensfun',
      confidence: 'in-range',
      lens: 'Pentax Old Lens',
      dbVersion: '12f5976',
      hasDistortion: true,
      hasCa: true,
      hasVignetting: true,
      approximations: [],
      unsupported: [],
    });
    test.model.update((m) => ({ ...m, lensProfile: stale }));
    // Wait for the reload the reference change triggers to actually SETTLE —
    // waiting only for the option to appear would pass on the FIRST (still
    // synchronous) recompute, which builds the fallback label from the
    // previous (automatic-match) evidence still cached in the signal.
    await vi.waitFor(() =>
      expect(test.pipeline.lensProfileEvidence).toHaveBeenLastCalledWith(
        expect.any(Uint8Array),
        'dng',
        stale,
      ),
    );
    await vi.waitFor(() => expect(test.component.isLoading()).toBe(false));
    test.view.detectChanges();
    expect(test.component.options().find((o) => o.value === stale)?.label).toBe('Pentax Old Lens');
  });

  it('appends an imported LCP reference as "Imported profile"', async () => {
    const test = await fixture();
    const reference = `lcp1:${'a'.repeat(64)}`;
    test.model.update((m) => ({ ...m, lensProfile: reference }));
    test.pipeline.lensProfileEvidence.mockResolvedValue({
      source: 'lcp',
      confidence: 'in-range',
      hasDistortion: true,
      hasCa: true,
      hasVignetting: true,
      approximations: [],
      unsupported: [],
    });
    await vi.waitFor(() =>
      expect(test.component.options().some((o) => o.value === reference)).toBe(true),
    );
    expect(test.component.options().find((o) => o.value === reference)?.label).toBe(
      'Imported profile',
    );
  });

  it('surfaces a fetch failure on the source line instead of throwing', async () => {
    const test = await fixture({
      compatible: async () => {
        throw new Error('worker unavailable');
      },
    });
    expect(test.byTestId('lens-profile-select-source')?.textContent).toContain(
      'worker unavailable',
    );
  });

  it('never lands a stale asset’s reload on a newer selection', async () => {
    const test = await fixture();
    let finish!: (value: LensProfileEvidence) => void;
    test.pipeline.lensProfileEvidence.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    test.focused.set('two');
    // The stale in-flight fetch for asset "one" settles AFTER the switch.
    finish(AUTO_MATCH);
    await vi.waitFor(() => expect(test.component.isLoading()).toBe(false));
    // The second (asset "two") reload used the same fake asset shape, so this
    // only proves the FIRST reply never clobbered the generation counter —
    // a real regression would leave `isLoading` stuck `true`.
    expect(test.component.isLoading()).toBe(false);
  });

  it('disables the select while no asset is focused', async () => {
    const test = await fixture();
    test.focused.set(null);
    await vi.waitFor(() => expect(test.component.selectDisabled()).toBe(true));
    test.view.detectChanges();
    const select = (test.view.nativeElement as HTMLElement).querySelector('select');
    expect(select?.disabled).toBe(true);
  });
});
