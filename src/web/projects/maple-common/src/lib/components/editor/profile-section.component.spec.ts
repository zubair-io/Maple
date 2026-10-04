import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProfileSectionComponent } from './profile-section.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { LibraryStateService } from '../../state/library-state.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';

describe('ProfileSectionComponent', () => {
  const outcomes = signal<Record<string, boolean | undefined>>({});
  const assetId = 'asset-1';
  let library: ReturnType<typeof makeLibraryStub> & {
    focusedAssetId: ReturnType<typeof signal<string | null>>;
  };

  beforeEach(() => {
    outcomes.set({});
    library = Object.assign(makeLibraryStub(), {
      focusedAssetId: signal<string | null>(assetId),
      lensCorrectionsFor: (id: string) => ({ autoFit: outcomes()[id] }),
    });
    TestBed.configureTestingModule({
      imports: [ProfileSectionComponent],
      providers: [
        { provide: LibraryStateService, useValue: library },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    TestBed.inject(EditorStateService).bind(assetId);
  });

  function render() {
    const fixture = TestBed.createComponent(ProfileSectionComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('shows Auto as the default and waits for the actual fit', () => {
    const fixture = render();
    const selected = fixture.nativeElement.querySelector('[role="radio"][aria-checked="true"]');
    expect(selected.textContent.trim()).toBe('Auto');
    expect(fixture.nativeElement.textContent).toContain('Checking Auto matching for this image…');
  });

  it('announces actual matching and generic unavailability for the focused image', () => {
    const fixture = render();
    const status = fixture.nativeElement.querySelector('[role="status"]');
    expect(status.getAttribute('aria-live')).toBe('polite');
    outcomes.set({ [assetId]: true });
    fixture.detectChanges();
    expect(status.textContent).toContain('matched to this image’s embedded camera preview');
    outcomes.set({ [assetId]: false });
    fixture.detectChanges();
    expect(status.textContent.trim()).toBe('Auto matching is unavailable for this image.');
    expect(status.textContent).not.toContain('no preview');
    library.focusedAssetId.set('asset-2');
    fixture.detectChanges();
    expect(status.textContent).toContain('Checking Auto matching');
    outcomes.set({ [assetId]: true });
    fixture.detectChanges();
    expect(status.textContent).toContain('Checking Auto matching');
    library.focusedAssetId.set(assetId);
    fixture.detectChanges();
    expect(status.textContent).toContain('matched to this image’s embedded camera preview');
  });

  it('selects Neutral as one undoable edit and persists the same render intent', () => {
    const fixture = render();
    const editor = TestBed.inject(EditorStateService);
    const buttons = fixture.nativeElement.querySelectorAll('button');
    buttons[1].click();
    fixture.detectChanges();

    expect(library.adjustmentFor(assetId)().profile).toBe('Neutral');
    expect(editor.undoHistory()).toHaveLength(1);
    expect(editor.undoHistory()[0].description).toBe('Profile: Neutral');
    const serializer = TestBed.inject(XmpSerializerService);
    const parser = TestBed.inject(XmpParserService);
    const xmp = serializer.serialize(library.adjustmentFor(assetId)());
    expect(parser.parseAdjustmentModel(xmp).model.profile).toBe('Neutral');
    expect(fixture.nativeElement.textContent).toContain('fixed base rendering');

    editor.undo();
    fixture.detectChanges();
    expect(fixture.componentInstance.profile()).toBe('Auto');
    editor.redo();
    fixture.detectChanges();
    expect(fixture.componentInstance.profile()).toBe('Neutral');
  });

  it('does not create an undo entry when reselecting the active option', () => {
    const fixture = render();
    fixture.componentInstance.select('Auto');
    expect(TestBed.inject(EditorStateService).undoHistory()).toHaveLength(0);
    expect(library.updateCount).toBe(0);
  });

  it('tracks the active asset and cannot edit when no asset is focused', () => {
    const fixture = render();
    library.updateAdjustment('asset-2', { profile: 'Neutral' });
    library.focusedAssetId.set('asset-2');
    TestBed.inject(EditorStateService).bind('asset-2');
    fixture.detectChanges();
    expect(fixture.componentInstance.profile()).toBe('Neutral');
    fixture.componentInstance.select('Auto');
    expect(library.adjustmentFor('asset-1')().profile).toBe('Auto');
    expect(library.adjustmentFor('asset-2')().profile).toBe('Auto');
    library.focusedAssetId.set(null);
    fixture.detectChanges();
    expect(
      [...fixture.nativeElement.querySelectorAll('button')].every(
        (b: HTMLButtonElement) => b.disabled,
      ),
    ).toBe(true);
  });
});
