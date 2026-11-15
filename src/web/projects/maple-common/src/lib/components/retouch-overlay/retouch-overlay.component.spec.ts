import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { RetouchOverlayComponent } from './retouch-overlay.component';
import { RetouchSessionService } from './retouch-session.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';

describe('RetouchOverlayComponent projected pointer bounds', () => {
  let session: RetouchSessionService;
  let surface: Element;

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const library = Object.assign(makeLibraryStub(), {
      focusedAsset: signal({ id: 'asset-1', width: 400, height: 400 }),
      focusedAssetId: signal('asset-1'),
    });
    library.updateAdjustment('asset-1', {
      crop: { top: 0, left: 0, bottom: 1, right: 1, angle: 10 },
      perspectiveX: 50,
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: library },
        { provide: RawPipelineService, useValue: {} },
        { provide: ImageCanvasService, useValue: { zoomToFit: vi.fn() } },
      ],
    });
    const editor = TestBed.inject(EditorStateService);
    editor.imageId.set('asset-1');
    editor.armTool('heal');
    session = TestBed.inject(RetouchSessionService);
    const fixture = TestBed.createComponent(RetouchOverlayComponent);
    Object.defineProperties(fixture.nativeElement, {
      clientWidth: { value: 400 },
      clientHeight: { value: 400 },
    });
    fixture.detectChanges();
    surface = fixture.nativeElement.querySelector('[data-testid="retouch-overlay"]');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function send(type: string, x: number, y: number): void {
    surface.dispatchEvent(
      new MouseEvent(type, {
        clientX: x * 400,
        clientY: y * 400,
        bubbles: true,
      }),
    );
  }

  it('does not place a repair in the rejected straightened corner', () => {
    send('pointerdown', 0.01, 0.01);
    send('pointerup', 0.01, 0.01);
    expect(session.spots()).toEqual([]);
  });

  it('keeps repair coordinates in the source frame under existing manual geometry', () => {
    send('pointerdown', 0.5, 0.5);
    send('pointerup', 0.5, 0.5);
    expect(session.spots()).toHaveLength(1);
    expect(session.spots()[0].center.x).toBeCloseTo(0.25, 9);
    expect(session.spots()[0].center.y).toBeCloseTo(0.5, 9);
  });

  it('skips rejected drag and release samples without moving the repair', () => {
    send('pointerdown', 0.3, 0.3);
    const before = session.spots();
    const update = vi.spyOn(session, 'setShape');
    send('pointermove', 0.01, 0.01);
    expect(session.spots()).toEqual(before);
    expect(update).not.toHaveBeenCalled();
    send('pointermove', 0.7, 0.7);
    expect(session.spots()).toHaveLength(1);
    expect(update).toHaveBeenCalledOnce();
    const resumed = session.spots();
    send('pointerup', 0.01, 0.01);
    expect(session.spots()).toEqual(resumed);
  });
});
