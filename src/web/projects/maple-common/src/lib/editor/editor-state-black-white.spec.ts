// editor-state-black-white.spec.ts — EditorStateService.setBlackWhite (#276).
//
// Split out of editor-state.service.spec.ts to keep that file under the
// 600-line file-size hard limit (CONTRIBUTING.md § "File-size budget") — it
// was already at the boundary before this ticket. Same lightweight
// LibraryStateService stand-in pattern as the main spec (no RawPipelineService
// stubbing needed here since setBlackWhite never touches the pipeline).

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { EditorStateService } from './editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { ALL_TOOLS, isWired } from './tool-model';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

  ensure(id: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, signal(defaultAdjustmentModel()));
    }
  }

  adjustmentFor(id: string): Signal<AdjustmentModel> {
    this.ensure(id);
    return this.models.get(id)!.asReadonly();
  }

  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void {
    this.ensure(id);
    this.models.get(id)!.update((m) => ({ ...m, ...patch }));
  }
}

describe('EditorStateService.setBlackWhite (#276)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  const ID = 'asset-1';

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
  });

  it('bwMix is registered as a wired tool alongside hsl (tool-catalog math)', () => {
    expect(ALL_TOOLS).toContain('bwMix');
    expect(isWired('bwMix')).toBe(true);
  });

  it('writes blackWhite through the commit/undo path as ONE undo entry', () => {
    expect(svc.canUndo()).toBe(false);
    svc.setBlackWhite('On');
    expect(lib.adjustmentFor(ID)().blackWhite).toBe('On');
    expect(svc.canUndo()).toBe(true);

    svc.undo();
    expect(lib.adjustmentFor(ID)().blackWhite).toBe('Off');
    svc.redo();
    expect(lib.adjustmentFor(ID)().blackWhite).toBe('On');
  });

  it('is a no-op when already at the requested mode (no junk undo entry)', () => {
    svc.setBlackWhite('Off'); // already Off
    expect(svc.canUndo()).toBe(false);
  });

  it('re-arms bwMix when turning On while hsl is armed', () => {
    svc.armTool('hsl');
    expect(svc.armedTool()).toBe('hsl');
    svc.setBlackWhite('On');
    expect(svc.armedTool()).toBe('bwMix');
  });

  it('does not disturb the armed tool when turning On while some other tool is armed', () => {
    svc.armTool('saturation');
    svc.setBlackWhite('On');
    expect(svc.armedTool()).toBe('saturation');
  });

  it('does not disturb the armed tool when turning Off', () => {
    svc.setBlackWhite('On');
    svc.armTool('bwMix');
    svc.setBlackWhite('Off');
    expect(svc.armedTool()).toBe('bwMix');
  });

  it('no-ops with no imageId bound', () => {
    svc.imageId.set(null);
    svc.setBlackWhite('On');
    expect(svc.canUndo()).toBe(false);
  });
});
