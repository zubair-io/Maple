// editor-shell-black-white.spec.ts — canvas-first editor (A) B&W / gray-mixer
// port (#276).
//
// bwMix mirrors HSL's shape (editor-shell-hsl.spec.ts): 8 sub-params with no
// single primary drag-bar field. Neither has a dock button of its own any
// more (#1807 Task 5 collapsed the dock to Apple's nine entries) — both are
// reached via the Colour sub-tool row instead (`control-card.component.ts`'s
// `SUBTOOLS` map; see `editor-shell-subtool-row.spec.ts` for the base
// reachability proof). Once armed, bwMix gets the same shared panel
// treatment (SubParamRowComponent / DragBarComponent / ValueChipComponent)
// plus an explicit toggle control for `model.blackWhite`.
//
// The acceptance-critical piece this spec locks down beyond the HSL parity
// checks: the shell still guards against HSL being the *armed* tool while
// Black & White is On (its 24 sliders are inert then, since B&W drives the
// same 8-band Oklab stage instead) — arming moves off it onto bwMix. Note
// this is a value-level guard now, not a dock-visibility one: the sub-tool
// row shows the HSL chip unconditionally (Task 4's `SUBTOOLS` map has no
// `blackWhiteOn` branch), so a tap on it while B&W is On briefly arms `hsl`
// before the shell's effect snaps back to `bwMix` on the next tick — this
// spec exercises that snap-back directly via `EditorStateService`, the way
// a preset apply or undo/redo landing would also trigger it.

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
      isSelecting: () => false,
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

  function subtoolChip(label: string): HTMLButtonElement {
    const chips = Array.from(
      fixture.nativeElement.querySelectorAll('pro-control-card .subtool-chip'),
    ) as HTMLButtonElement[];
    const chip = chips.find((c) => c.textContent?.trim() === label);
    expect(chip, `"${label}" sub-tool chip must be present`).not.toBeNull();
    return chip!;
  }

  /** Arms B&W the way a real user does post-#1807-Task-5: the dock has no
   *  B&W button any more, so this goes through the Color group dock entry
   *  and then the Colour sub-tool row's B&W chip. */
  function armBw(): void {
    requireDockButton('Color').click();
    fixture.detectChanges();
    subtoolChip('B&W').click();
    fixture.detectChanges();
  }

  /** Same as `armBw`, for HSL's chip. */
  function armHsl(): void {
    requireDockButton('Color').click();
    fixture.detectChanges();
    subtoolChip('HSL').click();
    fixture.detectChanges();
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

  // ── Sub-tool row entry + panel mount (HSL parity) ──────────────────────

  it('does NOT mount the B&W panel for a non-bwMix tool', () => {
    expect(bwPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('clicking the Colour sub-tool row B&W chip arms the tool and mounts the toggle + shared sub-param surface', () => {
    const editorState = TestBed.inject(EditorStateService);
    expect(editorState.armedTool()).not.toBe('bwMix');

    armBw();

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

    // Control card stays mounted while bwMix is armed (#1807 Task 4) — its
    // shared sub-param surface (`bwPanel()` above) now renders INSIDE the
    // card via content projection instead of suppressing it, keeping the
    // colour sub-tool row (Basic/HSL/B&W/Grade) reachable to switch back.
    // Crop is unaffected: it still hides the card entirely (own spec).
    expect(fixture.nativeElement.querySelector('pro-control-card')).not.toBeNull();
  });

  it('B&W highlights active on the Colour dock entry and on its own sub-tool chip', () => {
    armBw();

    // The dock's Color entry is a GROUP entry — it stays highlighted for any
    // tool armed within `color`, bwMix included (it's the sub-tool row's own
    // chip, checked below, that distinguishes bwMix from a plain slider).
    expect(requireDockButton('Color').classList.contains('dock-btn--active')).toBe(true);
    expect(subtoolChip('B&W').classList.contains('subtool-chip--active')).toBe(true);
    expect(subtoolChip('HSL').classList.contains('subtool-chip--active')).toBe(false);
  });

  it('selecting a chip arms that (tool, subParam) pair', () => {
    armBw();

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
    armBw();

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
    armBw();

    const toggle = bwToggle();
    expect(toggle.getAttribute('aria-label')).toBe('Black & White');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking the toggle flips model.blackWhite through the commit/undo path', () => {
    armBw();

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
    armBw();

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
    requireDockButton('Tone Curve').click();
    fixture.detectChanges();
    expect(curvePanel()).not.toBeNull();

    armBw();

    expect(curvePanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('arming B&W closes an open Presets panel', () => {
    requireDockButton('Presets').click();
    fixture.detectChanges();
    expect(presetsPanel()).not.toBeNull();

    armBw();

    expect(presetsPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('toggling Curve while B&W is armed is a no-op', () => {
    armBw();

    requireDockButton('Tone Curve').click();
    fixture.detectChanges();

    expect(curvePanel()).toBeNull();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(bwPanel()).not.toBeNull();
  });

  it('arming Crop closes an open B&W panel', () => {
    armBw();
    expect(bwPanel()).not.toBeNull();

    requireDockButton('Crop').click();
    fixture.detectChanges();

    expect(bwPanel()).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="crop-toolbar"]')).not.toBeNull();
  });

  // ── Acceptance requirement: HSL cannot be the ARMED tool while B&W is On,
  // and arming moves onto bwMix instead (#276). The sub-tool row itself
  // shows the HSL chip unconditionally now — Task 4's `SUBTOOLS` map has no
  // `blackWhiteOn` branch — so this is a value-level guard, not a
  // dock-visibility one; see the file header comment. ─────────────────────

  it('the HSL panel cannot be armed into existence while Black & White is On', () => {
    armBw();
    bwToggle().click();
    fixture.detectChanges();
    expect(modelFor(ASSET_ID)().blackWhite).toBe('On');

    // A direct arm (bypassing the chip tap, which would also trigger the
    // same effect) must not leave HSL as the visible surface — the shell's
    // safety-net effect re-arms bwMix.
    TestBed.inject(EditorStateService).armTool('hsl');
    fixture.detectChanges();

    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(hslPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });

  it('re-arms bwMix if HSL was the armed tool at the moment B&W switches On', () => {
    armHsl();
    expect(TestBed.inject(EditorStateService).armedTool()).toBe('hsl');
    expect(hslPanel()).not.toBeNull();

    // Flip the model directly (as a preset apply or undo/redo landing would).
    TestBed.inject(EditorStateService).setBlackWhite('On');
    fixture.detectChanges();

    expect(TestBed.inject(EditorStateService).armedTool()).toBe('bwMix');
    expect(hslPanel()).toBeNull();
    expect(bwPanel()).not.toBeNull();
  });
});
