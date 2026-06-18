import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { DevelopToolbarComponent } from './develop-toolbar.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';

function autoBtn(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('button[aria-label="Auto adjust"]')!;
}

function resetBtn(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('button[aria-label="Reset all adjustments"]')!;
}

describe('DevelopToolbarComponent', () => {
  const focusedAssetId = signal<string | null>(null);
  const autoInFlight = signal<boolean>(false);
  let resetAll: ReturnType<typeof vi.fn>;
  let applyAuto: ReturnType<typeof vi.fn>;
  let bind: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    focusedAssetId.set(null);
    autoInFlight.set(false);
    resetAll = vi.fn(() => true);
    applyAuto = vi.fn(() => Promise.resolve(true));
    bind = vi.fn();

    TestBed.configureTestingModule({
      imports: [DevelopToolbarComponent],
      providers: [
        { provide: LibraryStateService, useValue: { focusedAssetId } },
        { provide: EditorStateService, useValue: { bind, resetAll, applyAuto, autoInFlight } },
      ],
    });
  });

  it('disables Reset when no image is focused', () => {
    const f = TestBed.createComponent(DevelopToolbarComponent);
    f.detectChanges();
    expect(resetBtn(f.nativeElement).disabled).toBe(true);
  });

  it('enables Reset and calls resetAll exactly once on click', () => {
    focusedAssetId.set('asset-1');
    const f = TestBed.createComponent(DevelopToolbarComponent);
    f.detectChanges();
    const btn = resetBtn(f.nativeElement);
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(resetAll).toHaveBeenCalledTimes(1);
  });

  it('binds the editor state to the focused asset so RESET undo attaches to it', () => {
    focusedAssetId.set('asset-7');
    const f = TestBed.createComponent(DevelopToolbarComponent);
    f.detectChanges();
    expect(bind).toHaveBeenCalledWith('asset-7');
  });

  it('AUTO button is disabled when no image is focused', () => {
    focusedAssetId.set(null);
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).disabled).toBe(true);
  });

  it('AUTO button is enabled when an image is focused', () => {
    focusedAssetId.set('asset-1');
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).disabled).toBe(false);
  });

  it('AUTO button is disabled while autoInFlight is true', () => {
    focusedAssetId.set('asset-1');
    autoInFlight.set(true);
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).disabled).toBe(true);
  });

  it('clicking AUTO calls editor.applyAuto with the focused asset id', () => {
    focusedAssetId.set('asset-42');
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    autoBtn(fixture.nativeElement).click();
    expect(applyAuto).toHaveBeenCalledOnce();
    expect(applyAuto).toHaveBeenCalledWith('asset-42');
  });

  it('AUTO button has aria-label "Auto adjust"', () => {
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).getAttribute('aria-label')).toBe('Auto adjust');
  });

  it('AUTO button has aria-busy="true" while in flight', () => {
    focusedAssetId.set('asset-1');
    autoInFlight.set(true);
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).getAttribute('aria-busy')).toBe('true');
  });

  it('AUTO button has no aria-busy attribute when idle', () => {
    focusedAssetId.set('asset-1');
    autoInFlight.set(false);
    const fixture = TestBed.createComponent(DevelopToolbarComponent);
    fixture.detectChanges();
    expect(autoBtn(fixture.nativeElement).getAttribute('aria-busy')).toBeNull();
  });
});
