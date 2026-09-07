// editor-state.commit-on-release.spec.ts — Noise pill Deep + Prefilter
// (#1153) and the Deconv pill's Amount + Sigma (#3414).
//
// The BM3D deep-denoise and chroma-prefilter sub-params are far too
// expensive to re-render per pointer sample, so `EditorStateService` defers
// their writes: the drag bar tracks the finger live, but exactly ONE model
// write lands, at release. These tests pin that contract, and the fact that
// the cheap NLM tiers (luminance/color) still write per tick.
//
// Split out of `editor-state.service.spec.ts` for the file-size budget; the
// shared store stand-in lives in `editor-state.test-helpers.ts`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { EditorStateService } from './editor-state.service';
import { makeLibraryStub, type LibraryStub } from './editor-state.test-helpers';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';

describe('EditorStateService — commit-on-release sub-params (#1153)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  const ID = 'asset-1';

  beforeEach(() => {
    lib = makeLibraryStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        // Nothing here reaches the pipeline (applyAuto has its own suite);
        // the stand-in just keeps the real service out of the injector.
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
  });

  it('commit-on-release sub-params write ONCE per gesture, at release', () => {
    svc.armTool('noise');
    svc.armSubParam('deep');
    expect(svc.armedCommitsOnRelease()).toBe(true);

    lib.updateCount = 0;
    svc.beginGesture();
    // 40 pointer samples across the drag — the shape a real drag produces.
    for (let i = 1; i <= 40; i++) svc.setArmedDisplayValue(i);
    expect(lib.updateCount).toBe(0);
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(0);
    // ...but the drag bar still tracks the finger.
    expect(svc.armedDisplayValue()).toBe(40);
    expect(svc.hasDeferredValue()).toBe(true);

    svc.endGesture();
    expect(lib.updateCount).toBe(1);
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(40);
    expect(svc.hasDeferredValue()).toBe(false);
  });

  it('prefilter defers the same way; the NLM tiers still write per tick', () => {
    svc.armTool('noise');
    svc.armSubParam('prefilter');
    lib.updateCount = 0;
    svc.beginGesture();
    for (let i = 1; i <= 10; i++) svc.setArmedDisplayValue(i);
    expect(lib.updateCount).toBe(0);
    svc.endGesture();
    expect(lib.adjustmentFor(ID)().chromaPrefilter).toBe(10);
    expect(lib.updateCount).toBe(1);

    svc.armSubParam('luminance');
    expect(svc.armedCommitsOnRelease()).toBe(false);
    lib.updateCount = 0;
    svc.beginGesture();
    for (let i = 1; i <= 10; i++) svc.setArmedDisplayValue(i);
    expect(lib.updateCount).toBe(10);
    svc.endGesture();
    expect(lib.updateCount).toBe(10);
    expect(lib.adjustmentFor(ID)().nrLuminance).toBe(10);
  });

  it('a cancelled or re-armed gesture drops the deferred value unwritten', () => {
    svc.armTool('noise');
    svc.armSubParam('deep');
    svc.beginGesture();
    svc.setArmedDisplayValue(70);
    svc.cancelGesture();
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(0);

    svc.beginGesture();
    svc.setArmedDisplayValue(55);
    svc.armSubParam('color'); // arming elsewhere mid-gesture
    svc.endGesture();
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(0);
    expect(lib.adjustmentFor(ID)().nrColor).toBe(25);
  });

  it('both Deconv tiers defer their write to release (#3414)', () => {
    // Capture sharpening runs at develop's stage-14 position, upstream of the
    // whole GPU chain, so moving either field re-develops the decode prefix.
    // Both tiers therefore park the drag and write once, on release.
    svc.armTool('captureSharpen');
    expect(svc.armedSubParam()?.id).toBe('amount');
    expect(svc.armedCommitsOnRelease()).toBe(true);

    lib.updateCount = 0;
    svc.beginGesture();
    for (let i = 1; i <= 40; i++) svc.setArmedDisplayValue(i);
    expect(lib.updateCount).toBe(0);
    expect(lib.adjustmentFor(ID)().captureSharpeningAmount).toBe(0);
    // ...while the drag bar still tracks the finger.
    expect(svc.armedDisplayValue()).toBe(40);
    svc.endGesture();
    expect(lib.updateCount).toBe(1);
    expect(lib.adjustmentFor(ID)().captureSharpeningAmount).toBe(40);

    svc.armSubParam('sigma');
    expect(svc.armedCommitsOnRelease()).toBe(true);
    lib.updateCount = 0;
    svc.beginGesture();
    for (const v of [1.1, 1.3, 1.6, 1.4]) svc.setArmedDisplayValue(v);
    expect(lib.updateCount).toBe(0);
    expect(lib.adjustmentFor(ID)().captureSharpeningSigma).toBe(1);
    svc.endGesture();
    expect(lib.updateCount).toBe(1);
    expect(lib.adjustmentFor(ID)().captureSharpeningSigma).toBe(1.4);
  });

  it('a Deconv drag is ONE undo entry, not one per tick (#3414)', () => {
    svc.armTool('captureSharpen');
    // The drag bar opens the transaction on pointer-down and `endGesture()`
    // closes it — the same boundary pair every slider gesture uses.
    svc.commit('adjustment', 'Deconv');
    svc.beginGesture();
    for (let i = 1; i <= 25; i++) svc.setArmedDisplayValue(i * 2);
    svc.endGesture();
    expect(lib.adjustmentFor(ID)().captureSharpeningAmount).toBe(50);

    svc.undo();
    expect(lib.adjustmentFor(ID)().captureSharpeningAmount).toBe(0);
    svc.redo();
    expect(lib.adjustmentFor(ID)().captureSharpeningAmount).toBe(50);
  });

  it('reset writes through even for a commit-on-release sub-param', () => {
    svc.armTool('noise');
    svc.armSubParam('deep');
    svc.beginGesture();
    svc.setArmedDisplayValue(60);
    svc.endGesture();
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(60);
    svc.resetArmedTool();
    expect(lib.adjustmentFor(ID)().deepDenoise).toBe(0);
  });
});
