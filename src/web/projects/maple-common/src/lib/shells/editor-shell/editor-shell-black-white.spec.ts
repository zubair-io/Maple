// editor-shell-black-white.spec.ts — canvas-first editor (A) B&W / gray-mixer
// port (#276).
//
// bwMix mirrors HSL's shape (editor-shell-hsl.spec.ts): 8 sub-params with no
// single primary drag-bar field, so it gets the same dock-entry → shared
// panel treatment (SubParamRowComponent / DragBarComponent /
// ValueChipComponent) plus an explicit toggle control for `model.blackWhite`.
//
// The acceptance-critical piece this spec locks down beyond the HSL parity
// checks: while Black & White is On, the ENTIRE HSL surface must be
// hidden — the HSL dock entry does not render, the HSL panel cannot be
// armed into existence, and it reappears the moment B&W is switched back
// Off. If HSL happens to be the armed tool at the moment B&W turns On,
// arming moves off it onto bwMix rather than pointing the drag bar at a
// tool with no visible way to reach it.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('EditorShellComponent — B&W / gray-mixer port (#276)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  beforeEach(() => {
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
      flushPendingXmpWrites: vi.fn(),
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
            // #2240: `ImageCanvasComponent`'s template reads this signal
            // every change-detection pass, so the stub has to carry it even
            // though nothing here exercises deep denoise.
            deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
          },
        },
      ],
    });

    TestBed.inject(ImageCanvasService);
    TestBed.inject(EditorStateService).bind(ASSET_ID);
    TestBed.inject(CropSessionService);

    fixture = TestBed.createComponent(EditorShellComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // Filters by attribute value in JS rather than a `[aria-label="..."]` CSS
  // attribute selector — jsdom's selector engine mis-parses an unescaped `&`
  // inside a bracketed attribute-value string (reproduced standalone against
  // node_modules/jsdom; not an app bug), and "B&W" is exactly that label.
  function dockButton(label: string): HTMLButtonElement | null {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('pro-tool-dock button'),
    ) as HTMLButtonElement[];
    return buttons.find((b) => b.getAttribute('aria-label') === label) ?? null;
  }

  function requireDockButton(label: string): HTMLButtonElement {
    const btn = dockButton(label);
    expect(btn).not.toBeNull();
    return btn!;
  }

  function bwPanel(): Element | null {
    return fixture.nativeElement.querySelector('.bw-panel');
  }

  function hslPanel(): Element | null {
    return fixture.nativeElement.querySelector('.hsl-panel');
  }

  function curvePanel(): Element | null {
    return fixture.nativeElement.querySelector('.curve-panel');
  }

  function presetsPanel(): Element | null {
    return fixture.nativeElement.querySelector('.presets-panel');
  }

  function bwToggle(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="bw-toggle"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  // ── Dock entry + panel mount (HSL parity) ──────────────────────────────

  it('dock renders a B&W entry with an accessible label', () => {
    const btn = requireDockButton('B&W');
    expect(btn.disabled).toBe(false);
  });

  it('does NOT mount the B&W panel for a non-bwMix tool', () => {
    expect(bwPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('clicking the B&W dock entry arms the tool and mounts the toggle + shared sub-param surface', () => {
    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedTool()).not.toBe('bwMix');

    requireDockButton('B&W').click();
    fixture.detectChanges();

    expect(editorState.armedTool()).toBe('bwMix');
    expect(editorState.armedGroup()).toBe('color');

    expect(bwPanel()).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="bw-toggle"]')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="editor-subparam-row"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="editor-drag-bar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="editor-value-chip"]')).not.toBeNull();

    expect(editorState.armedSubParamId()).toBe('bwRed');

    // Control card hidden while bwMix is armed — same as HSL/Crop.
    expect(fixture.nativeElement.querySelector('pro-control-card')).toBeNull();
  });

  it('B&W highlights active in the dock while armed, and Color does not', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    expect(requireDockButton('B&W').classList.contains('dock-btn--active')).toBe(true);
    expect(requireDockButton('Color').classList.contains('dock-btn--active')).toBe(false);
  });

  it('selecting a chip arms that (tool, subParam) pair', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedSubParamId()).toBe('bwRed');

    const orangeChip = fixture.nativeElement.querySelector(
      '[data-testid="editor-subparam-bwOrange"]',
    ) as HTMLButtonElement | null;
    expect(orangeChip).not.toBeNull();

    orangeChip!.click();
    fixture.detectChanges();

    expect(editorState.armedSubParamId()).toBe('bwOrange');
  });

  it('a drag-bar edit on the default-armed sub-param writes grayMixerRed', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(modelFor(ASSET_ID)().grayMixerRed).toBe(0);

    editorState.commit();
    editorState.setArmedInternalValue(40);
    fixture.detectChanges();

    const after = modelFor(ASSET_ID)();
    expect(after.grayMixerRed).toBeCloseTo(40, 5);
    expect(after.grayMixerOrange).toBe(0);
  });

  // ── B&W toggle control ──────────────────────────────────────────────────

  it('the toggle has an accessible label and reflects model.blackWhite', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    const toggle = bwToggle();
    expect(toggle.getAttribute('aria-label')).toBe('Black & White');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking the toggle flips model.blackWhite through the commit/undo path', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.canUndo()).toBe(false);
    expect(modelFor(ASSET_ID)().blackWhite).toBe('Off');

    bwToggle().click();
    fixture.detectChanges();

    expect(modelFor(ASSET_ID)().blackWhite).toBe('On');
    expect(bwToggle().getAttribute('aria-checked')).toBe('true');
    expect(editorState.canUndo()).toBe(true);

    editorState.undo();
    fixture.detectChanges();
    expect(modelFor(ASSET_ID)().blackWhite).toBe('Off');
  });

  it('the 8 sub-param sliders are visibly de-emphasised while the toggle is Off', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    const sliders = fixture.nativeElement.querySelector('[data-testid="bw-panel-sliders"]')!;
    expect(sliders.classList.contains('bw-panel-sliders--inactive')).toBe(true);
    expect(sliders.getAttribute('aria-disabled')).toBe('true');

    bwToggle().click();
    fixture.detectChanges();

    expect(sliders.classList.contains('bw-panel-sliders--inactive')).toBe(false);
    expect(sliders.getAttribute('aria-disabled')).toBe('false');
  });

  // ── B&W / Curve / Crop / Presets / HSL mutual exclusion ─────────────────

  it('arming B&W closes an open Curve panel', () => {
    requireDockButton('Curve').click();
    fixture.detectChanges();
    expect(curvePanel()).not.toBeNull();

    requireDockButton('B&W').click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('arming B&W closes an open Presets panel', () => {
    requireDockButton('Presets').click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    requireDockButton('B&W').click();
    fixture.detectChanges();

    expect(presetsPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('toggling Curve while B&W is armed is a no-op', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();

    requireDockButton('Curve').click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(bwPanel()).not.toBeNull();
  });

  it('arming Crop closes an open B&W panel', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();
    expect(bwPanel()).not.toBeNull();

    requireDockButton('Crop').click();
    fixture.detectChanges();

    expect(bwPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  // ── Acceptance requirement: the HSL surface is fully hidden while B&W is
  // On, and returns the moment it's switched back Off (#276) ──────────────

  it('the HSL dock entry disappears once Black & White is switched On', () => {
    expect(dockButton('HSL')).not.toBeNull();

    requireDockButton('B&W').click();
    fixture.detectChanges();
    bwToggle().click();
    fixture.detectChanges();

    expect(modelFor(ASSET_ID)().blackWhite).toBe('On');
    expect(dockButton('HSL')).toBeNull();
  });

  it('the HSL panel cannot be armed into existence while Black & White is On', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();
    bwToggle().click();
    fixture.detectChanges();

    expect(dockButton('HSL')).toBeNull();
    // Even a direct arm (bypassing the now-absent dock entry) must not
    // leave HSL as the visible surface — the shell's safety-net effect
    // re-arms bwMix.
    TestBed.inject(EditorStateService).armTool('hsl');
    fixture.detectChanges();

    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(hslPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('the HSL dock entry and surface reappear once Black & White is switched back Off', () => {
    requireDockButton('B&W').click();
    fixture.detectChanges();
    bwToggle().click();
    fixture.detectChanges();
    expect(dockButton('HSL')).toBeNull();

    bwToggle().click(); // back to Off
    fixture.detectChanges();

    expect(modelFor(ASSET_ID)().blackWhite).toBe('Off');
    expect(dockButton('HSL')).not.toBeNull();

    requireDockButton('HSL').click();
    fixture.detectChanges();
    expect(hslPanel()).not.toBeNull();
  });

  it('re-arms bwMix if HSL was the armed tool at the moment B&W switches On', () => {
    requireDockButton('HSL').click();
    fixture.detectChanges();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('hsl');
    expect(hslPanel()).not.toBeNull();

    // Flip the model directly (as a preset apply or undo/redo landing would)
    // rather than going through the dock, since the dock entry that could
    // reach the toggle while HSL is armed doesn't exist.
    TestBed.inject(EditorStateService).setBlackWhite('On');
    fixture.detectChanges();

    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(hslPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });
});
