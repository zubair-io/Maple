import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { DevelopToolbarComponent } from './develop-toolbar.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';

describe('DevelopToolbarComponent', () => {
  const focusedAssetId = signal<string | null>(null);
  let resetAll: ReturnType<typeof vi.fn>;
  let bind: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    focusedAssetId.set(null);
    resetAll = vi.fn(() => true);
    bind = vi.fn();
    TestBed.configureTestingModule({
      imports: [DevelopToolbarComponent],
      providers: [
        { provide: LibraryStateService, useValue: { focusedAssetId } },
        { provide: EditorStateService, useValue: { bind, resetAll } },
      ],
    });
  });

  function resetButton(host: HTMLElement): HTMLButtonElement {
    return host.querySelector('button[aria-label="Reset all adjustments"]')!;
  }

  it('disables Reset when no image is focused', () => {
    const f = TestBed.createComponent(DevelopToolbarComponent);
    f.detectChanges();
    expect(resetButton(f.nativeElement).disabled).toBe(true);
  });

  it('enables Reset and calls resetAll exactly once on click', () => {
    focusedAssetId.set('asset-1');
    const f = TestBed.createComponent(DevelopToolbarComponent);
    f.detectChanges();
    const btn = resetButton(f.nativeElement);
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
});
