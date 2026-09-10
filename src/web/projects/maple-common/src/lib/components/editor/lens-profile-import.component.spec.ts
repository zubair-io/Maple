// LensProfileImportComponent — unit tests (#3479).
//
// Stubs the three services the component talks to: the library (focused
// asset + its adjustment model + the per-asset resolver verdict), the
// editor (undo transaction bracket) and the pipeline (the worker import +
// the availability status broadcast). Self Hosted's server client is a
// TestBed fake, so no HttpClient is involved.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { LensProfileImportComponent } from './lens-profile-import.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { LensCorrectionCapability } from '../../state/library-store-lens-corrections';
import type {
  ImportedLensProfile,
  LensProfileResolution,
  LensProfileStatus,
} from '../../lens/lens-profile.types';
import { LensProfileServer } from '../../lens/lens-profile-server.service';

const reference = `lcp1:${'a'.repeat(64)}`;

function resolution(approximate = false): LensProfileResolution {
  return {
    source: 'lcp',
    confidence: approximate ? 'approximate' : 'in-range',
    approximations: approximate ? ['Missing focus distance'] : [],
    unsupported: [],
    hasDistortion: true,
    hasCa: false,
    hasVignetting: true,
    distortion: [{ index: 1, weight: 1, focalMm: 35, apertureApex: 4, focusM: 5 }],
    ca: [],
    vignetting: [],
  };
}

function profile(approximate = false): ImportedLensProfile {
  return {
    reference,
    name: 'Test calibration',
    make: 'Maple',
    camera: 'Body',
    lens: 'Prime',
    sampleCount: 1,
    resolution: resolution(approximate),
  };
}

async function fixture(backend: 'hosted' | 'self-hosted' = 'hosted') {
  const focused = signal<string | null>('one');
  const model = signal(defaultAdjustmentModel());
  const capabilities = signal<LensCorrectionCapability>({
    hasLensCorrections: false,
    lensCorrectionCaInert: true,
  });
  const editor = { commit: vi.fn(), endEdit: vi.fn() };
  const pipeline = {
    importLensProfile: vi.fn().mockResolvedValue(profile()),
    lensProfileStatus: signal<LensProfileStatus | null>(null),
  };
  // The lazily-imported server client (`lens-profile-server-bridge.ts`)
  // resolves through the injector, so a TestBed fake stands in for HttpClient.
  const server = { upload: vi.fn(() => of({ reference })), restore: vi.fn() };
  const library = {
    backend,
    focusedAssetId: focused,
    focusedAsset: () => (focused() ? { id: focused(), filename: 'photo.DNG' } : null),
    adjustmentFor: () => model,
    lensCorrectionsFor: () => capabilities(),
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
      { provide: LensProfileServer, useValue: server },
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
  const text = () => (view.nativeElement as HTMLElement).textContent ?? '';
  const byTestId = (id: string) =>
    (view.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    view,
    component: view.componentInstance,
    library,
    focused,
    model,
    capabilities,
    editor,
    pipeline,
    server,
    choose,
    text,
    byTestId,
  };
}

describe('LensProfileImportComponent', () => {
  it('applies an in-range import as one undoable edit and clears it the same way', async () => {
    const test = await fixture();
    await test.choose();
    test.view.detectChanges();
    expect(test.model().lensProfile).toBe('');
    expect(test.byTestId('lens-profile-candidate')?.textContent).toContain('Test calibration');
    expect(test.byTestId('lens-profile-families')?.textContent).toContain(
      'Calibrated: distortion, vignetting · Not calibrated: chromatic aberration',
    );
    expect(test.byTestId('lens-profile-acknowledge')).toBeNull();
    expect(test.pipeline.importLensProfile).toHaveBeenCalledWith(
      '<lcp/>',
      expect.any(Uint8Array),
      'dng',
    );

    test.component.apply();
    expect(test.model().lensProfile).toBe(reference);
    expect(test.editor.commit).toHaveBeenCalledWith('adjustment', 'Select lens profile');
    expect(test.editor.commit).toHaveBeenCalledTimes(1);
    expect(test.editor.endEdit).toHaveBeenCalledTimes(1);
    expect(test.component.visibleCandidate()).toBeNull();

    test.component.clear();
    expect(test.model().lensProfile).toBe('');
    expect(test.editor.commit).toHaveBeenCalledTimes(2);
    expect(test.editor.endEdit).toHaveBeenCalledTimes(2);
  });

  it('records approximation acceptance only through the separate control', async () => {
    const test = await fixture();
    test.pipeline.importLensProfile.mockResolvedValue(profile(true));
    await test.choose();
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-approximation')?.textContent).toContain(
      'Missing focus distance',
    );
    expect(test.byTestId('lens-profile-acknowledge')).not.toBeNull();
    expect(test.component.canApply()).toBe(false);

    test.component.apply();
    expect(test.library.updateAdjustment).not.toHaveBeenCalled();

    test.component.acknowledged.set(true);
    expect(test.component.canApply()).toBe(true);
    test.component.apply();
    expect(test.model().lensProfile).toBe(reference.replace('lcp1:', 'lcp1-ack:'));
    expect(test.editor.commit).toHaveBeenCalledTimes(1);
  });

  it('keeps exact UTF-8 BOM bytes in the content-addressed profile', async () => {
    const test = await fixture();
    await test.choose('﻿<lcp/>');
    expect(test.pipeline.importLensProfile.mock.calls[0][0]).toBe('﻿<lcp/>');
  });

  it('never offers an import to a subsequently selected photo', async () => {
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

  it('shows a mismatch or unsupported model as an error with nothing to accept', async () => {
    const test = await fixture();
    test.pipeline.importLensProfile.mockRejectedValue(
      new Error('LCP camera model does not match: Other Body'),
    );
    await test.choose();
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-error')?.textContent).toContain('does not match');
    expect(test.byTestId('lens-profile-apply')).toBeNull();
    test.component.apply();
    expect(test.library.updateAdjustment).not.toHaveBeenCalled();
  });

  it('reports an embedded-corrections RAW and offers nothing to apply', async () => {
    const test = await fixture();
    test.pipeline.importLensProfile.mockResolvedValue({
      ...profile(),
      resolution: {
        source: 'embedded',
        confidence: 'embedded',
        approximations: [],
        unsupported: [],
      },
    });
    await test.choose();
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-embedded')).not.toBeNull();
    expect(test.byTestId('lens-profile-apply')).toBeNull();
    expect(test.component.canApply()).toBe(false);
  });

  it('describes the selected profile from the renderer verdict once a render carried it', async () => {
    const test = await fixture();
    test.model.update((m) => ({ ...m, lensProfile: reference }));
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-selection')?.textContent).toContain('Waiting');
    expect(test.byTestId('lens-profile-resolution')).toBeNull();

    test.capabilities.set({
      hasLensCorrections: false,
      lensCorrectionCaInert: true,
      lensProfile: { ...resolution(), reference, enabled: true },
    });
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-selection')?.textContent).toContain('selected');
    expect(test.byTestId('lens-profile-resolution')?.textContent).toContain(
      'within the calibrated',
    );
    expect(test.byTestId('lens-profile-apply')).toBeNull();
  });

  it('shows an explicit error when no cache can supply the selected profile', async () => {
    const test = await fixture();
    test.model.update((m) => ({ ...m, lensProfile: reference.replace('lcp1:', 'lcp1-ack:') }));
    test.pipeline.lensProfileStatus.set({
      id: 0,
      type: 'lens-profile-status',
      reference,
      available: false,
      message: 'Import the original .lcp file.',
    });
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-unavailable')?.textContent).toContain(
      'Import the original .lcp file.',
    );

    // A status about some other profile says nothing about this selection.
    test.pipeline.lensProfileStatus.set({
      id: 0,
      type: 'lens-profile-status',
      reference: `lcp1:${'b'.repeat(64)}`,
      available: false,
      message: 'other',
    });
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-unavailable')).toBeNull();

    // Embedded corrections won: the missing bytes were never needed.
    test.pipeline.lensProfileStatus.set({
      id: 0,
      type: 'lens-profile-status',
      reference,
      available: false,
      message: 'missing',
    });
    test.capabilities.set({
      hasLensCorrections: true,
      lensCorrectionCaInert: false,
      lensProfile: {
        source: 'embedded',
        confidence: 'embedded',
        reference: reference.replace('lcp1:', 'lcp1-ack:'),
        approximations: [],
        unsupported: [],
      },
    });
    test.view.detectChanges();
    expect(test.byTestId('lens-profile-unavailable')).toBeNull();
    expect(test.byTestId('lens-profile-embedded')).not.toBeNull();
  });

  it('uploads to the server on Self Hosted and refuses a reference disagreement', async () => {
    const test = await fixture('self-hosted');
    await test.choose();
    expect(test.server.upload).toHaveBeenCalledTimes(1);
    expect(test.component.visibleCandidate()?.reference).toBe(reference);

    test.server.upload.mockReturnValue(of({ reference: `lcp1:${'b'.repeat(64)}` }));
    await test.choose();
    expect(test.component.visibleCandidate()).toBeNull();
    expect(test.component.error()).toContain('disagree');
  });

  it('never talks to the server on Hosted', async () => {
    const test = await fixture('hosted');
    await test.choose();
    expect(test.server.upload).not.toHaveBeenCalled();
    expect(test.component.visibleCandidate()?.reference).toBe(reference);
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
