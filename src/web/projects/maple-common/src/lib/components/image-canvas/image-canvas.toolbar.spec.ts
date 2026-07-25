// ImageCanvasComponent — hideToolbar input (#1558).
// The legacy canvas toolbar (the h-[34px] div) is wrapped in @if (!hideToolbar()):
// absent when the Pro editor passes [hideToolbar]="true", present by default
// (the classic 3-column editor). Split into its own spec to stay under the
// file-budget; the main two-phase/GPU specs live in image-canvas.component.spec.ts.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

describe('ImageCanvasComponent — hideToolbar input (#1558)', () => {
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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
    const stateStub = {
      focusedAsset: signal<Asset | null>(null),
      adjustmentFor: (_id: AssetId) => signal(defaultAdjustmentModel()),
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;
    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          // #1153: the canvas template reads the deep-denoise progress signal.
          useValue: {
            decode: vi.fn(() => new Promise(() => {})),
            deepDenoiseProgress: signal(null),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('shows the toolbar by default (hideToolbar=false)', () => {
    expect(fixture.nativeElement.querySelector('.h-\\[34px\\]')).not.toBeNull();
  });

  it('hides the toolbar when hideToolbar=true', () => {
    fixture.componentRef.setInput('hideToolbar', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.h-\\[34px\\]')).toBeNull();
  });
});
