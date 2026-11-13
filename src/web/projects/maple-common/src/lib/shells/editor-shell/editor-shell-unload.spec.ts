import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { EMPTY } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EditorShellComponent } from './editor-shell.component';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { SidecarSaveStateService } from '../../xmp/sidecar-save-state.service';

function setup() {
  const flushPendingXmpWrites = vi.fn();
  const flushPendingPreviewWrites = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: { url: EMPTY } },
      {
        provide: LibraryStateService,
        useValue: { flushPendingXmpWrites, flushPendingPreviewWrites },
      },
      { provide: ImageCanvasService, useValue: {} },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new EditorShellComponent());
  return {
    component,
    saves: TestBed.inject(SidecarSaveStateService),
    flushPendingXmpWrites,
    flushPendingPreviewWrites,
  };
}

describe('EditorShell unload', () => {
  it.each(['idle', 'saved'] as const)('does not start an XMP flush when %s', (phase) => {
    const { component, saves, flushPendingXmpWrites, flushPendingPreviewWrites } = setup();
    if (phase === 'saved') {
      const older = saves.queued('photo');
      const semantic = saves.queued('photo');
      saves.saved('photo', semantic);
      saves.saving('photo', older);
    }

    component.onBeforeUnload();

    expect(flushPendingXmpWrites).not.toHaveBeenCalled();
    expect(flushPendingPreviewWrites).toHaveBeenCalledOnce();
  });

  it.each(['unsaved', 'saving', 'error'] as const)(
    'still flushes pending edits when %s',
    (phase) => {
      const { component, saves, flushPendingXmpWrites, flushPendingPreviewWrites } = setup();
      const revision = saves.queued('photo');
      if (phase === 'saving') saves.saving('photo', revision);
      if (phase === 'error') saves.failed('photo', revision, Error('Write failed'));

      component.onBeforeUnload();

      expect(flushPendingXmpWrites).toHaveBeenCalledOnce();
      expect(flushPendingPreviewWrites).toHaveBeenCalledOnce();
    },
  );
});
