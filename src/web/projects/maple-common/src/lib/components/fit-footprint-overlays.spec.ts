// Each overlay that draws at the fit footprint registers with the real
// ImageCanvasService while active and lets go when it ends or is destroyed
// (#5743). The service holds the canvas at fit until every overlay is gone.

import { signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CropOverlayComponent } from './crop-overlay/crop-overlay.component';
import { MaskOverlayComponent } from './mask-overlay/mask-overlay.component';
import { RetouchOverlayComponent } from './retouch-overlay/retouch-overlay.component';
import { ImageCanvasService } from './image-canvas/image-canvas.service';
import { EditorStateService } from '../editor/editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub } from '../editor/editor-state.test-helpers';

describe('fit-footprint overlays register with the canvas service (#5743)', () => {
  let svc: ImageCanvasService;
  let editor: EditorStateService;

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      putImageData: vi.fn(),
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
    } as never);
    const library = Object.assign(makeLibraryStub(), {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: library },
        {
          provide: RawPipelineService,
          useValue: {
            currentWorkerEpoch: () => 0,
            registerBrushRaster: vi.fn().mockResolvedValue(1),
            releaseMaskRaster: vi.fn(),
          },
        },
      ],
    });
    svc = TestBed.inject(ImageCanvasService);
    editor = TestBed.inject(EditorStateService);
    editor.imageId.set('asset-1');
    editor.armTool('exposure');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount(component: Type<unknown>) {
    const fixture = TestBed.createComponent(component);
    fixture.detectChanges();
    TestBed.tick();
    return fixture;
  }

  it('crop holds from mount to destroy, and mounting snaps a zoomed canvas to fit', () => {
    svc.pixelScale.set(2);
    svc.pan.set({ x: 40, y: 10 });
    editor.armTool('crop');
    const fixture = mount(CropOverlayComponent);
    expect(svc.holdsAtFit()).toBe(true);
    expect(svc.pixelScale()).toBe(0);
    expect(svc.pan()).toEqual({ x: 0, y: 0 });
    fixture.destroy();
    expect(svc.holdsAtFit()).toBe(false);
  });

  it.each([
    ['mask', 'mask', MaskOverlayComponent],
    ['heal', 'heal', RetouchOverlayComponent],
  ] as const)(
    '%s holds while its tool is armed, and lets go when it is disarmed',
    (_name, tool, component) => {
      mount(component);
      expect(svc.holdsAtFit()).toBe(false);
      svc.pixelScale.set(2);
      editor.armTool(tool);
      TestBed.tick();
      expect(svc.holdsAtFit()).toBe(true);
      expect(svc.pixelScale()).toBe(0);
      editor.armTool('exposure');
      TestBed.tick();
      expect(svc.holdsAtFit()).toBe(false);
    },
  );

  it.each([
    ['mask', 'mask', MaskOverlayComponent],
    ['heal', 'heal', RetouchOverlayComponent],
  ] as const)('%s lets go on destroy while still active', (_name, tool, component) => {
    editor.armTool(tool);
    const fixture = mount(component);
    expect(svc.holdsAtFit()).toBe(true);
    fixture.destroy();
    expect(svc.holdsAtFit()).toBe(false);
  });

  it('switching from crop to mask never releases the hold', () => {
    editor.armTool('crop');
    const crop = mount(CropOverlayComponent);
    mount(MaskOverlayComponent);
    editor.armTool('mask');
    TestBed.tick();
    const heldOnSwitch = svc.holdsAtFit();
    crop.destroy();
    expect([heldOnSwitch, svc.holdsAtFit()]).toEqual([true, true]);
  });

  it('registering twice and deregistering once releases the hold', () => {
    svc.setFitFootprintOverlay('crop', true);
    svc.setFitFootprintOverlay('crop', true);
    svc.setFitFootprintOverlay('crop', false);
    expect(svc.holdsAtFit()).toBe(false);
  });
});
