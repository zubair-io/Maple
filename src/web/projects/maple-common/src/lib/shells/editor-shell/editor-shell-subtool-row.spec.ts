// editor-shell-subtool-row.spec.ts — colour/effects sub-tool row reachability
// through the REAL shell template (#1807 Task 4, review finding #3).
//
// Task 4's whole purpose is guaranteeing HSL, B&W and Color Grading stay
// reachable once a later task collapses the dock and removes their
// dedicated buttons. Every other reachability check for this feature lives
// either inside the isolated `ControlCardComponent` fixture
// (control-card.component.spec.ts, which stubs `toolChange`/`groupChange`
// rather than exercising the real arming machinery) or asserts indirectly
// that `pro-control-card` is non-null (editor-shell-hsl.spec.ts,
// editor-shell-black-white.spec.ts). Neither actually clicks a
// `.subtool-chip` inside the real shell template and checks that
// `EditorStateService.armedTool()` changed — this file does.
//
// Also covered review finding #1 (now retired by #1807 Task 5): on phone,
// both close paths for the OLD closeable flyout (`closeRequest` from the
// card's own X button, and re-tapping the active dock group icon) used to
// only flip `phoneCardOpen`, which did nothing while a field-less sub-tool
// was armed — the `[closed]` binding was ALSO kept open by
// `hslArmed()`/`bwMixArmed()`/`colorGradeArmed()`. Task 5 deleted the whole
// closeable-flyout mechanism (`phoneCardOpen`, `closed`, `closeRequest`,
// `editor-shell-subtool.ts`'s `closePhoneCard`): the phone card is now
// always visible, same as tablet/desktop, so there is no close path left to
// test. The phone describe block below instead proves HSL/B&W/Grade stay
// reachable through the sub-tool row on the always-visible card, and that no
// close button renders.
//
// Boilerplate follows editor-shell-hsl.spec.ts / editor-shell-auto-reset
// .spec.ts's `setWindowWidth` pattern for the phone-breakpoint cases.

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

function setWindowWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

describe('EditorShellComponent — colour/effects sub-tool row reachability (#1807 Task 4 review)', () => {
  let fixture: ComponentFixture<EditorShellComponent>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let focused: WritableSignal<Asset | null>;
  const originalInnerWidth = window.innerWidth;

  function modelFor(id: AssetId): WritableSignal<AdjustmentModel> {
    if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
    return models.get(id)!;
  }

  function setup(width: number): void {
    stubGlobals();
    setWindowWidth(width);

    models = new Map();
    focused = signal<Asset | null>({
      id: ASSET_ID,
      filename: 'a.dng',
      width: 6240,
      height: 4160,
    } as Asset);

    const route = { url: of([]), snapshot: { paramMap: convertToParamMap({}), url: [] } };

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
  }

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
    setWindowWidth(originalInnerWidth);
  });

  function dockButton(label: string): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('pro-tool-dock button'),
    ) as HTMLButtonElement[];
    // JS string comparison, not a CSS attribute selector — jsdom mis-parses
    // an unescaped `&` inside a bracketed `[aria-label="..."]` value (see
    // editor-shell-black-white.spec.ts), which this sidesteps.
    const btn = buttons.find((b) => b.getAttribute('aria-label') === label);
    expect(btn, `dock button "${label}" must be present`).not.toBeNull();
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

  describe('tablet/desktop', () => {
    beforeEach(() => setup(1280));

    it('clicking the HSL then B&W chip arms each tool through the real shell wiring', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Color').click();
      fixture.detectChanges();
      expect(editorState.armedGroup()).toBe('color');

      subtoolChip('HSL').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('hsl');

      subtoolChip('B&W').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('bwMix');
    });

    it('clicking the Grade chip in the effects row arms colorGrade through the real shell wiring', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Effects').click();
      fixture.detectChanges();
      expect(editorState.armedGroup()).toBe('effects');

      subtoolChip('Grade').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('colorGrade');
    });

    it('Basic escapes HSL back to the colour group’s first slider tool', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Color').click();
      fixture.detectChanges();
      subtoolChip('HSL').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('hsl');

      subtoolChip('Basic').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('temp');
      expect(editorState.armedGroup()).toBe('color');
    });

    it('Basic escapes Color Grading back to the effects group’s first slider tool', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Effects').click();
      fixture.detectChanges();
      subtoolChip('Grade').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('colorGrade');

      subtoolChip('Basic').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('clarity');
      expect(editorState.armedGroup()).toBe('effects');
    });
  });

  describe('phone — the always-visible card keeps HSL/B&W/Grade reachable (#1807 Task 5)', () => {
    beforeEach(() => setup(375));

    function phoneCard(): Element | null {
      return fixture.nativeElement.querySelector('.phone-card-anchor pro-control-card .card');
    }

    it('the card is visible before any dock tap — no tap is required to reach it', () => {
      expect(phoneCard()).not.toBeNull();
    });

    it('no close button renders in the phone card header', () => {
      dockButton('Color').click();
      fixture.detectChanges();
      subtoolChip('HSL').click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.phone-card-anchor .close-btn')).toBeNull();
    });

    it('arming HSL then B&W through the sub-tool row stays reachable on the always-visible card', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Color').click();
      fixture.detectChanges();
      expect(phoneCard()).not.toBeNull();

      subtoolChip('HSL').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('hsl');
      expect(phoneCard()).not.toBeNull();

      subtoolChip('B&W').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('bwMix');
      expect(phoneCard()).not.toBeNull();
    });

    it('arming Color Grading through the effects row stays reachable, and Basic escapes back', () => {
      const editorState = TestBed.inject(EditorStateService);
      dockButton('Effects').click();
      fixture.detectChanges();
      subtoolChip('Grade').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('colorGrade');
      expect(phoneCard()).not.toBeNull();

      subtoolChip('Basic').click();
      fixture.detectChanges();
      expect(editorState.armedTool()).toBe('clarity');
      expect(editorState.armedGroup()).toBe('effects');
    });
  });
});
