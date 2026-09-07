import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LensProfileImportComponent } from './lens-profile-import.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { ImportedLensProfile } from '../../lens/lens-profile.types';

const reference = `lcp1:${'a'.repeat(64)}`;
function profile(approximate = false): ImportedLensProfile {
  return {
    reference,
    name: 'Test calibration',
    camera: 'Body',
    lens: 'Prime',
    resolution: {
      source: 'lcp',
      confidence: approximate ? 'approximate' : 'in-range',
      approximations: approximate ? ['Missing focus distance'] : [],
      unsupported: [],
      distortion: [],
      ca: [],
      vignetting: [],
    },
  };
}

async function fixture() {
  const focused = signal<string | undefined>('one');
  const model = signal(defaultAdjustmentModel());
  const editor = { commit: vi.fn(), endEdit: vi.fn() };
  const pipeline = { importLensProfile: vi.fn().mockResolvedValue(profile()) };
  const library = {
    backend: 'hosted',
    focusedAssetId: focused,
    focusedAsset: () => ({ id: focused(), filename: 'photo.dng' }),
    adjustmentFor: () => model,
    lensCorrectionsFor: () => ({}),
    bytesForAsset: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
    updateAdjustment: vi.fn((_: string, patch: object) =>
      model.update((value) => ({ ...value, ...patch })),
    ),
  };
  TestBed.configureTestingModule({
    imports: [LensProfileImportComponent],
    providers: [
      { provide: LibraryStateService, useValue: library },
      { provide: EditorStateService, useValue: editor },
      { provide: RawPipelineService, useValue: pipeline },
    ],
  });
  await TestBed.compileComponents();
  const view = TestBed.createComponent(LensProfileImportComponent);
  view.detectChanges();
  const choose = (xml = '<lcp/>') =>
    view.componentInstance.choose({
      target: {
        value: 'file.lcp',
        files: [
          { size: xml.length, arrayBuffer: async () => new TextEncoder().encode(xml).buffer },
        ],
      },
    } as unknown as Event);
  return {
    view,
    component: view.componentInstance,
    library,
    focused,
    model,
    editor,
    pipeline,
    choose,
  };
}

describe('lens profile import', () => {
  it('requires a discrete choice and records approximation acceptance in one undo edit', async () => {
    const test = await fixture();
    test.pipeline.importLensProfile.mockResolvedValue(profile(true));
    await test.choose();
    expect(test.model().lensProfile).toBe('');
    test.view.detectChanges();
    expect(test.view.nativeElement.textContent).toContain('Accept approximation and use profile');
    test.component.apply();
    expect(test.model().lensProfile).toBe(reference.replace('lcp1:', 'lcp1-ack:'));
    expect(test.editor.commit).toHaveBeenCalledTimes(1);
    expect(test.editor.endEdit).toHaveBeenCalledTimes(1);
    test.component.clear();
    expect(test.model().lensProfile).toBe('');
    expect(test.editor.commit).toHaveBeenCalledTimes(2);
  });

  it('keeps exact UTF-8 BOM bytes in the content-addressed profile', async () => {
    const test = await fixture();
    await test.choose('\ufeff<lcp/>');
    expect(test.pipeline.importLensProfile.mock.calls[0][0]).toBe('\ufeff<lcp/>');
  });

  it('does not apply a result to a subsequently selected photo', async () => {
    const test = await fixture();
    let finish!: (value: ImportedLensProfile) => void;
    test.pipeline.importLensProfile.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = test.choose();
    await vi.waitFor(() => expect(test.pipeline.importLensProfile).toHaveBeenCalled());
    test.focused.set('two');
    finish(profile());
    await pending;
    test.component.apply();
    expect(test.library.updateAdjustment).not.toHaveBeenCalled();
    expect(test.component.visibleCandidate()).toBeNull();
  });

  it('leaves the sidecar unchanged when persistence fails', async () => {
    const test = await fixture();
    test.pipeline.importLensProfile.mockRejectedValue(new Error('Profile cache is full'));
    await test.choose();
    test.component.apply();
    expect(test.component.error()).toBe('Profile cache is full');
    expect(test.library.updateAdjustment).not.toHaveBeenCalled();
  });
});
