// editor-shell-parity.spec.ts — canvas-first editor (A) parity with the S5
// editor (B), epic #1807 slice 5.
//
// B (`editor.component.ts` + `editor-header.component.ts`) ships three things
// A lacked entirely:
//   - an Undo/Redo top-bar button (tap = undo, long-press 500ms = redo,
//     disabled when there's nothing to undo/redo) — see
//     `editor-header.component.ts` `onUndoPointerDown/Up/Cancel`.
//   - an Info button opening `InfoPanelComponent` as a bottom sheet on phone
//     / a right-side pane on tablet+ — the same split
//     `preview-shell.component.ts` already uses for its own Info surface.
//   - hiding the phone bottom tab bar for the duration of the edit session
//     via `TabBarVisibilityService` (`editor.component.ts`'s `ngOnInit` /
//     `ngOnDestroy`).
//
// This spec proves the port: the SAME `EditorStateService.undo()`/`redo()`
// this shell already binds via keyboard now also drive a real button, the
// SAME `InfoPanelComponent` (`asset` / `insideSheet` inputs, `close` output)
// B's header wires up now mounts here too, and `TabBarVisibilityService.hidden`
// flips exactly like every other push-mode surface (Loupe, Preview, S5 Editor).
//
// Full template render, following the stubbing pattern shared by
// editor-shell-crop.spec.ts / editor-shell-presets.spec.ts / editor-shell-hsl.spec.ts.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { EditorShellComponent } from './editor-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { CropSessionService } from '../../components/crop-overlay/crop-session.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { TabBarVisibilityService } from '../tab-bar-visibility.service';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

const ASSET_ID = 'library:2026/a.dng' as AssetId;

function stubGlobals(): void {
  const observerStub = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;
  (globalThis as unknown as { ImageData: unknown }).ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(() =>
    Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
  );
}

function setWindowWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', {
    value: w,
    configurable: true,
    writable: true,
  });
}

describe('EditorShellComponent — parity with the S5 editor (epic #1807 slice 5)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;
  const originalInnerWidth = window.innerWidth;

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  function setup(): void {
    vi.useFakeTimers();
    stubGlobals();

    models = new Map();
    focused = signal<Asset | null>({
      id: ASSET_ID,
      filename: 'a.dng',
      width: 6240,
      height: 4160,
    } as Asset);

    const route = {
      url: of([]),
      snapshot: { paramMap: convertToParamMap({}), url: [] },
    };

    const stateStub = {
      backend: 'self-hosted',
      focusedAsset: focused,
      focusedAssetId: () => focused()?.id ?? null,
      assets: () => [focused()!].filter(Boolean),
      assetsInSelectedFolder: () => [focused()!].filter(Boolean),
      adjustmentFor: (id: AssetId) => modelFor(id),
      updateAdjustment: (id: AssetId, patch: Partial<AdjustmentModel>) => {
        modelFor(id).update((m) => ({ ...m, ...patch }));
      },
      selectAsset: vi.fn(),
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
      flushPendingXmpWrites: vi.fn(() => Promise.resolve()),
      flushPendingPreviewWrites: vi.fn(),
      hydrateSelfHostedFsAsset: vi.fn(() => null),
      openSelfHostedSubfolder: vi.fn(),
    } as unknown as Partial<LibraryStateService>;

    TestBed.configureTestingModule({
      imports: [EditorShellComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        XmpSerializerService,
        { provide: ActivatedRoute, useValue: route },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: LibraryStateService, useValue: stateStub },
        // Hosted backend: PresetsService uses IndexedDB (not HTTP), and
        // InfoPanelComponent's self-hosted-only enrichment child stays
        // unmounted so this spec doesn't need to stub that surface.
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
        {
          provide: RawPipelineService,
          useValue: {
            // #1153: the canvas template reads the deep-denoise progress signal.
            deepDenoiseProgress: signal(null),
            decode: vi.fn(() =>
              Promise.resolve({
                width: 800,
                height: 533,
                nativeWidth: 6240,
                nativeHeight: 4160,
                rgb: new Uint8Array([0x80, 0x80, 0x80]),
                asShotTemperature: 5200,
                asShotTint: 0,
              }),
            ),
          },
        },
      ],
    });

    TestBed.inject(ImageCanvasService);
    TestBed.inject(EditorStateService).bind(ASSET_ID);
    TestBed.inject(CropSessionService);

    fixture = TestBed.createComponent(EditorShellComponent);
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
    setWindowWidth(originalInnerWidth);
  });

  function undoButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="editor-shell-undo"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function infoButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="editor-shell-info"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  function pointerEvent(type: string): PointerEvent {
    return new PointerEvent(type, { bubbles: true });
  }

  // ── Undo / redo button ────────────────────────────────────────────────

  describe('undo/redo top-bar button', () => {
    beforeEach(setup);

    it('is disabled when there is nothing to undo or redo', () => {
      expect(undoButton().disabled).toBe(true);
    });

    it('a tap (pointerdown + quick pointerup) calls EditorStateService.undo()', () => {
      const editorState = TestBed.inject(EditorStateService);
      // Seed one undo-able edit.
      editorState.commit();
      editorState.setArmedInternalValue(20);
      fixture.detectChanges();
      expect(undoButton().disabled).toBe(false);

      const undoSpy = vi.spyOn(editorState, 'undo');
      const redoSpy = vi.spyOn(editorState, 'redo');

      const btn = undoButton();
      btn.dispatchEvent(pointerEvent('pointerdown'));
      // Released well before the 500ms long-press threshold.
      vi.advanceTimersByTime(100);
      btn.dispatchEvent(pointerEvent('pointerup'));

      expect(undoSpy).toHaveBeenCalledTimes(1);
      expect(redoSpy).not.toHaveBeenCalled();
    });

    it('a long-press (>= 500ms held) calls EditorStateService.redo(), not undo()', () => {
      const editorState = TestBed.inject(EditorStateService);
      editorState.commit();
      editorState.setArmedInternalValue(20);
      fixture.detectChanges();

      const undoSpy = vi.spyOn(editorState, 'undo');
      const redoSpy = vi.spyOn(editorState, 'redo');

      const btn = undoButton();
      btn.dispatchEvent(pointerEvent('pointerdown'));
      vi.advanceTimersByTime(500);
      // The long-press timer itself calls redo(); pointerup afterward must
      // NOT also call undo() (mirrors editor-header.component.ts's
      // `longPressed` guard).
      btn.dispatchEvent(pointerEvent('pointerup'));

      expect(redoSpy).toHaveBeenCalledTimes(1);
      expect(undoSpy).not.toHaveBeenCalled();
    });

    it('pointercancel aborts the long-press timer without calling undo or redo', () => {
      const editorState = TestBed.inject(EditorStateService);
      editorState.commit();
      editorState.setArmedInternalValue(20);
      fixture.detectChanges();

      const undoSpy = vi.spyOn(editorState, 'undo');
      const redoSpy = vi.spyOn(editorState, 'redo');

      const btn = undoButton();
      btn.dispatchEvent(pointerEvent('pointerdown'));
      btn.dispatchEvent(pointerEvent('pointercancel'));
      vi.advanceTimersByTime(600);

      expect(undoSpy).not.toHaveBeenCalled();
      expect(redoSpy).not.toHaveBeenCalled();
    });
  });

  // ── Info button + sheet/pane ──────────────────────────────────────────

  describe('Info button', () => {
    it('opens InfoPanelComponent as a right-side pane on tablet/desktop', () => {
      setWindowWidth(1024);
      setup();

      expect(fixture.nativeElement.querySelector('.info-pane')).toBeNull();

      infoButton().click();
      fixture.detectChanges();

      const pane = fixture.nativeElement.querySelector('.info-pane');
      expect(pane).not.toBeNull();
      expect(pane!.querySelector('app-info-panel')).not.toBeNull();

      // Closing via the panel's own (close) output collapses the pane.
      // Angular `output<void>()` is NOT a native DOM event — dispatching a
      // `CustomEvent('close')` on the host element does not reach the
      // `(close)="infoOpen.set(false)"` template binding at all, so a test
      // that only did that (and never re-ran change detection or asserted
      // the pane was gone) would pass even if closing were fully broken
      // (#1816 review). Emit through the component instance's actual
      // output and assert the pane is actually removed afterward.
      const panelDebugEl = fixture.debugElement.query(By.directive(InfoPanelComponent));
      expect(panelDebugEl).not.toBeNull();
      panelDebugEl.componentInstance.close.emit();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.info-pane')).toBeNull();
    });

    it('opens InfoPanelComponent inside a bottom sheet on phone', () => {
      setWindowWidth(500);
      setup();

      infoButton().click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.info-pane')).toBeNull();
      const sheetPanel = fixture.nativeElement.querySelector('app-bottom-sheet app-info-panel');
      expect(sheetPanel).not.toBeNull();
    });

    it('toggles closed on a second click', () => {
      setWindowWidth(1024);
      setup();

      infoButton().click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.info-pane')).not.toBeNull();

      infoButton().click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.info-pane')).toBeNull();
    });
  });

  // ── Phone tab-bar visibility ───────────────────────────────────────────

  describe('TabBarVisibilityService', () => {
    it('hides the phone tab bar on init and restores it on destroy', () => {
      setup();
      const tabBar = TestBed.inject(TabBarVisibilityService);

      expect(tabBar.hidden()).toBe(true);

      fixture.destroy();
      expect(tabBar.hidden()).toBe(false);
    });
  });
});
