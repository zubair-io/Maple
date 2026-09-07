// mask-panel.component.spec.ts — the mask panel's per-kind controls (#3300).
//
// The feather slider is gated on the selected layer's mask KIND, not on the
// feather value: a geometric mask keeps its slider at feather 0 (a hard
// edge is a valid setting the user must be able to soften again — a
// truthiness `@if` would unmount it, Jules review on #3430), while a bitmap
// or everywhere mask, which has no parametric edge, hides it.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';

import { MaskPanelComponent } from './mask-panel.component';
import { MaskSessionService } from '../mask-overlay/mask-session.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub, type LibraryStub } from '../../editor/editor-state.test-helpers';

describe('MaskPanelComponent feather slider (#3300)', () => {
  let lib: LibraryStub & { focusedAsset: ReturnType<typeof signal> };
  let session: MaskSessionService;

  beforeEach(() => {
    const stub = makeLibraryStub();
    lib = Object.assign(stub, {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    }) as typeof lib;
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    TestBed.inject(EditorStateService).imageId.set('asset-1');
    session = TestBed.inject(MaskSessionService);
  });

  const featherSlider = (host: HTMLElement): HTMLElement | null =>
    (Array.from(host.querySelectorAll('mui-living-slider')).find(
      (el) => el.getAttribute('label') === 'Feather' || el.textContent?.includes('Feather'),
    ) as HTMLElement | undefined) ?? null;

  it('keeps the slider mounted at feather 0 for a geometric mask', () => {
    session.addLinear();
    session.setFeather(0);
    const fixture = TestBed.createComponent(MaskPanelComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const mask = session.selected()?.mask;
    expect(mask?.kind === 'linear' ? mask.feather : null).toBe(0);
    expect(featherSlider(host)).not.toBeNull();
  });

  it('hides the slider for a bitmap or everywhere mask', () => {
    session.add({ kind: 'everywhere' });
    const fixture = TestBed.createComponent(MaskPanelComponent);
    fixture.detectChanges();
    expect(featherSlider(fixture.nativeElement as HTMLElement)).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Everywhere 1');
  });
});
