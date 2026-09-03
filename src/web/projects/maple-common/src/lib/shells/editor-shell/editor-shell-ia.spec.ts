// editor-shell-ia.spec.ts — the responsive-shell information architecture
// (#2449, milestone 18 design spec §3.2) through the REAL shell template:
//
//   - every primary job has one stable, named home at phone and desktop
//     widths (`data-editor-region` + landmark labels), in the same order;
//   - the scopes panel (#2449's "cheap win") mounts from the top-bar toggle,
//     shares the dock-side anchor with Curve/Presets (mutually exclusive),
//     and closes when Crop takes the anchor;
//   - a LIVE breakpoint change re-lays the chrome out around unchanged state:
//     the focused asset, the edit history, the armed tool and the zoom/pan
//     all survive phone ↔ desktop resizes, and the deferred (commit-on-
//     release) value is never flushed by the resize.
//
// Boilerplate follows editor-shell-subtool-row.spec.ts's full-render harness.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
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
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

const ASSET_A = 'library:2026/a.dng' as AssetId;
const ASSET_B = 'library:2026/b.dng' as AssetId;

/** The top-bar regions every breakpoint must expose, in the same order. */
const TOP_BAR_REGIONS = [
  'top-bar',
  'navigation',
  'identity',
  'scopes',
  'comparison',
  'inspector-toggle',
  'export',
];

/** Regions that exist on every breakpoint but whose DOM order follows the
 *  visible layout: the dock precedes the card on tablet/desktop (right
 *  column), the card sits ABOVE the bottom dock on phone — focus order
 *  follows what is on screen in both cases. */
const TOOL_REGIONS = ['tools', 'tool-controls'];

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
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

/** Resize the window the way a real browser does: width, then the event. */
function resizeTo(w: number): void {
  setWindowWidth(w);
  window.dispatchEvent(new Event('resize'));
}

describe('EditorShellComponent — responsive IA (#2449)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;
  const originalInnerWidth = window.innerWidth;

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  function asset(id: AssetId, filename: string): Asset {
    return { id, filename, width: 6240, height: 4160 } as Asset;
  }

  function setup(width: number): void {
    stubGlobals();
    setWindowWidth(width);

    models = new Map();
    focused = signal<Asset | null>(asset(ASSET_A, 'a.dng'));
    const folder = [asset(ASSET_A, 'a.dng'), asset(ASSET_B, 'b.dng')];

    const route = { url: of([]), snapshot: { paramMap: convertToParamMap({}), url: [] } };

    const stateStub = {
      backend: 'self-hosted',
      focusedAsset: focused,
      focusedAssetId: () => focused()?.id ?? null,
      assets: () => folder,
      assetsInSelectedFolder: () => folder,
      isSelecting: () => false,
      adjustmentFor: (id: AssetId) => modelFor(id),
      updateAdjustment: (id: AssetId, patch: Partial<AdjustmentModel>) => {
        modelFor(id).update((m) => ({ ...m, ...patch }));
      },
      selectAsset: vi.fn(),
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      seedLensCorrections: vi.fn(),
      lensCorrectionsFor: vi.fn(() => ({ hasLensCorrections: true, lensCorrectionCaInert: false })),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
      flushPendingXmpWrites: vi.fn(),
      flushPendingPreviewWrites: vi.fn(),
      hydrateSelfHostedFsAsset: vi.fn(() => null),
      openSelfHostedSubfolder: vi.fn(),
      thumbnailUrlFor: vi.fn(() => null),
      ensureThumbnailUrl: vi.fn(),
      subscribeThumbUrl: vi.fn(() => () => {}),
      cancelQueuedThumbnail: vi.fn(),
      peekNext: vi.fn(() => null),
      peekPrev: vi.fn(() => null),
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
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
        {
          provide: RawPipelineService,
          useValue: {
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
            deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
          },
        },
      ],
    });

    TestBed.inject(ImageCanvasService);
    TestBed.inject(EditorStateService).bind(ASSET_A);
    TestBed.inject(CropSessionService);

    fixture = TestBed.createComponent(EditorShellComponent);
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
    setWindowWidth(originalInnerWidth);
  });

  function regions(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-editor-region]') as NodeListOf<HTMLElement>,
    ).map((el) => el.dataset['editorRegion'] ?? '');
  }

  function landmark(label: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[role="region"][aria-label="${label}"]`);
  }

  function byTestId(id: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  }

  describe('stable regions', () => {
    it('desktop exposes every primary region in task order, plus the filmstrip', () => {
      setup(1440);
      const found = regions();
      expect(found.filter((r) => TOP_BAR_REGIONS.includes(r))).toEqual(TOP_BAR_REGIONS);
      expect(found.filter((r) => TOOL_REGIONS.includes(r))).toEqual(['tools', 'tool-controls']);
      expect(found).toContain('filmstrip');
      expect(landmark('Filmstrip')).not.toBeNull();
      expect(landmark('Tool controls')).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[role="toolbar"][aria-label="Editor top bar"]'),
      ).not.toBeNull();
      expect(fixture.nativeElement.querySelector('nav[aria-label="Editor tools"]')).not.toBeNull();
    });

    it('phone exposes the same regions in the same order, with the bottom dock and no filmstrip', () => {
      setup(390);
      const found = regions();
      expect(found.filter((r) => TOP_BAR_REGIONS.includes(r))).toEqual(TOP_BAR_REGIONS);
      // Card above the dock on phone — DOM order matches the visible order.
      expect(found.filter((r) => TOOL_REGIONS.includes(r))).toEqual(['tool-controls', 'tools']);
      expect(found).not.toContain('filmstrip');
      expect(
        fixture.nativeElement.querySelector('pro-tool-dock.dock-host--horizontal'),
      ).not.toBeNull();
      expect(landmark('Tool controls')).not.toBeNull();
    });

    it('the inspector is a docked pane named Info on desktop', () => {
      setup(1440);
      byTestId('editor-shell-info')!.click();
      fixture.detectChanges();
      expect(landmark('Info')).not.toBeNull();
      expect(regions()).toContain('inspector');
    });

    it('the inspector is a sheet in the same region on phone', () => {
      setup(390);
      byTestId('editor-shell-info')!.click();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('mui-sheet-shell[data-editor-region="inspector"]'),
      ).not.toBeNull();
    });
  });

  describe('scopes panel', () => {
    it('opens from the top-bar toggle on desktop, hides the control card, and is exclusive with Curve', () => {
      setup(1440);
      const toggle = byTestId('editor-shell-scopes') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-pressed')).toBe('false');

      toggle.click();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(byTestId('editor-shell-scopes-panel')).not.toBeNull();
      expect(landmark('Scopes')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('editor-scopes-panel')).not.toBeNull();
      expect(landmark('Tool controls')).toBeNull();

      fixture.componentInstance.onCurvePanelToggle();
      fixture.detectChanges();
      expect(fixture.componentInstance.curveOpen()).toBe(true);
      expect(fixture.componentInstance.scopesOpen()).toBe(false);
      expect(byTestId('editor-shell-scopes-panel')).toBeNull();
    });

    it('opens as a flyout on phone and closes when Crop takes the anchor', () => {
      setup(390);
      byTestId('editor-shell-scopes')!.click();
      fixture.detectChanges();
      expect(byTestId('editor-shell-scopes-panel')).not.toBeNull();

      fixture.componentInstance.onToolChange('crop');
      fixture.detectChanges();
      expect(fixture.componentInstance.scopesOpen()).toBe(false);
      expect(byTestId('editor-shell-scopes-panel')).toBeNull();
      // While Crop owns the anchor the toggle is a no-op.
      byTestId('editor-shell-scopes')!.click();
      fixture.detectChanges();
      expect(fixture.componentInstance.scopesOpen()).toBe(false);
    });

    it('reports the no-frame state instead of mounting the organism without pixels', () => {
      setup(1440);
      byTestId('editor-shell-scopes')!.click();
      fixture.detectChanges();
      const panel = byTestId('editor-shell-scopes-panel')!;
      expect(panel.querySelector('mui-scopes-panel')).toBeNull();
      expect(panel.querySelector('[role="status"]')?.textContent).toContain('live frame');
    });
  });

  describe('live breakpoint change', () => {
    it('preserves the asset, edit history, armed tool, zoom/pan and a parked value across phone ↔ desktop', () => {
      setup(1440);
      const editorState = TestBed.inject(EditorStateService);
      const canvasSvc = TestBed.inject(ImageCanvasService);

      // Edit history + armed tool.
      editorState.armTool('contrast');
      editorState.commit();
      editorState.setArmedDisplayValue(25);
      expect(editorState.canUndo()).toBe(true);
      // Zoom / pan.
      canvasSvc.setPixelScale(2);
      canvasSvc.pan.set({ x: 40, y: -12 });
      // A parked commit-on-release value mid-gesture (Noise → Deep).
      editorState.armTool('noise');
      editorState.armSubParam('deep');
      editorState.beginGesture();
      editorState.setArmedDisplayValue(30);
      expect(editorState.hasDeferredValue()).toBe(true);
      expect(modelFor(ASSET_A)().deepDenoise).toBe(0);
      fixture.detectChanges();

      resizeTo(390);
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('pro-tool-dock.dock-host--horizontal'),
      ).not.toBeNull();

      expect(editorState.imageId()).toBe(ASSET_A);
      expect(editorState.armedTool()).toBe('noise');
      expect(editorState.armedSubParamId()).toBe('deep');
      expect(editorState.canUndo()).toBe(true);
      expect(modelFor(ASSET_A)().contrast).toBe(25);
      expect(canvasSvc.pixelScale()).toBe(2);
      expect(canvasSvc.pan()).toEqual({ x: 40, y: -12 });
      // The resize must not flush (or drop) the in-flight gesture.
      expect(editorState.hasDeferredValue()).toBe(true);
      expect(modelFor(ASSET_A)().deepDenoise).toBe(0);

      resizeTo(1440);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('pro-tool-dock.dock-host--horizontal')).toBeNull();
      expect(editorState.armedTool()).toBe('noise');
      expect(canvasSvc.pixelScale()).toBe(2);
      expect(editorState.hasDeferredValue()).toBe(true);

      editorState.endGesture();
      expect(modelFor(ASSET_A)().deepDenoise).toBe(30);
    });

    it('keeps an open scopes panel open across a resize', () => {
      setup(1440);
      byTestId('editor-shell-scopes')!.click();
      fixture.detectChanges();
      resizeTo(390);
      fixture.detectChanges();
      expect(fixture.componentInstance.scopesOpen()).toBe(true);
      expect(byTestId('editor-shell-scopes-panel')).not.toBeNull();
    });
  });
});
