// Canvas-scrub gesture for EditorShellComponent (#1535).
// Extracted from the component to keep editor-shell.component.ts under the
// per-file LOC budget. Operates on the live component via its public surface
// (the `scrub` bag of mutable fields it owns); `import type` keeps this a
// type-only (no runtime) dependency on the shell.
//
// Horizontal drag at fit-zoom (pixelScale === 0) moves the armed tool's
// internal value at 0.5:1 sensitivity (2× canvas width = ±100 internal),
// with a HUD readout while dragging and chrome pinned to the 'scrubbing'
// dim level for the duration.
import type { EditorShellComponent } from './editor-shell.component';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { CANVAS_POINTER_OWNERS } from '../../components/image-canvas/image-canvas.zoom-gestures';

/** Mutable scrub-gesture bookkeeping, owned by the shell and passed by
 *  reference so this module can read/write it without the fields living
 *  directly on the component class (they aren't template-visible). */
export interface ScrubGestureState {
  /** The pointer driving the scrub; null when no scrub is in flight. */
  pointerId: number | null;
  startX: number;
  startInternal: number;
  /** The whole model as the scrub found it: a tick can change more than the
   *  armed value (a Temperature tick also makes the white balance Custom). */
  startModel: AdjustmentModel | null;
  moveBound: ((e: PointerEvent) => void) | null;
  upBound: ((e: PointerEvent) => void) | null;
  cancelBound: ((e: PointerEvent) => void) | null;
}

export function newScrubGestureState(): ScrubGestureState {
  return {
    pointerId: null,
    startX: 0,
    startInternal: 0,
    startModel: null,
    moveBound: null,
    upBound: null,
    cancelBound: null,
  };
}

/** pointerdown on the canvas layer — starts the scrub gesture. Only scrubs
 *  while nothing overflows the viewport (fit or below), primary button and
 *  primary pointer only, and only when the armed tool accepts value edits
 *  (e.g. not while Crop is armed).
 *
 *  The scrub never captures the pointer: the image canvas inside this layer
 *  already holds it (its pinch needs every pointer's moves and releases), and
 *  the scrub follows its own pointer through window listeners. A second
 *  pointer landing mid-scrub makes the gesture a pinch, so the scrub puts
 *  the model back and stops; a new primary press means the old scrub's
 *  release never arrived, so that scrub is abandoned and a new one starts. */
export function onCanvasPointerDown(
  shell: EditorShellComponent,
  scrub: ScrubGestureState,
  e: PointerEvent,
): void {
  if (scrub.pointerId !== null) {
    if (e.isPrimary === false) {
      yieldScrubToPinch(shell, scrub);
      return;
    }
    onScrubCancel(shell, scrub);
  }
  if (e.button !== 0 || e.isPrimary === false) return;
  // A canvas layer that took the press (a crop or mask handle) owns it.
  if (e.defaultPrevented) return;
  // A control or a descendant that owns its pointer stream (the eyedropper
  // pick overlay) must not start a scrub: that would commit an edit and
  // retarget the click it is waiting for.
  if (e.target instanceof Element && e.target.closest(CANVAS_POINTER_OWNERS)) return;
  if (!shell.canvasSvc.pointerEditsAtZoom()) return;
  if (!shell.editorState.armedToolAcceptsValueEdits()) return;

  const wrap = shell.canvasWrapRef?.nativeElement;
  if (!wrap) return;

  e.preventDefault();
  scrub.pointerId = e.pointerId;
  scrub.startX = e.clientX;
  scrub.startInternal = shell.editorState.armedInternalValue();
  scrub.startModel = shell.editorState.currentAdjustment();

  shell.editorState.commit();
  // Commit-on-release sub-params (Noise → Deep / Prefilter, #1153) park their
  // value for the duration of the gesture instead of re-developing per move.
  shell.editorState.beginGesture();
  shell.scrubbing.set(true);
  shell.chromeState.set('scrubbing');
  shell.showHud();

  const ownPointer = (ev: PointerEvent): boolean => ev.pointerId === scrub.pointerId;
  scrub.moveBound = (ev: PointerEvent) => {
    if (ownPointer(ev)) onScrubMove(shell, scrub, ev);
  };
  scrub.upBound = (ev: PointerEvent) => {
    if (ownPointer(ev)) onScrubUp(shell, scrub, ev);
  };
  scrub.cancelBound = (ev: PointerEvent) => {
    if (ownPointer(ev)) onScrubCancel(shell, scrub);
  };
  window.addEventListener('pointermove', scrub.moveBound);
  window.addEventListener('pointerup', scrub.upBound);
  window.addEventListener('pointercancel', scrub.cancelBound);
}

/** A second pointer joined: the scrub's first few pixels of travel were the
 *  start of a pinch, not an edit. Put the model back as the scrub found it,
 *  drop any parked value and abandon the edit, so no undo entry is left. */
function yieldScrubToPinch(shell: EditorShellComponent, scrub: ScrubGestureState): void {
  const id = shell.editorState.imageId();
  if (id != null && scrub.startModel)
    shell.editorState.library.updateAdjustment(id, scrub.startModel);
  shell.editorState.cancelGesture();
  shell.editorState.cancelEdit();
  cleanupScrub(shell, scrub);
  shell.hudVisible.set(false);
  shell.chromeState.set('full');
  shell.restartRecedeTimer();
}

function onScrubMove(shell: EditorShellComponent, scrub: ScrubGestureState, e: PointerEvent): void {
  const wrap = shell.canvasWrapRef?.nativeElement;
  if (!wrap) return;
  const wrapW = wrap.clientWidth;
  if (wrapW <= 0) return;

  // 0.5:1 sensitivity: 2× canvas width = ±100 internal
  const dx = e.clientX - scrub.startX;
  const delta = (dx / wrapW) * 100;
  const raw = scrub.startInternal + delta * 0.5;
  const clamped = Math.min(100, Math.max(-100, raw));
  shell.editorState.setArmedInternalValue(clamped);
  shell.showHud();
}

function onScrubUp(shell: EditorShellComponent, scrub: ScrubGestureState, _e: PointerEvent): void {
  // Release is the commit point for deferred (decode-product) sub-params.
  shell.editorState.endGesture();
  cleanupScrub(shell, scrub);
  shell.scheduleHudFade();
  shell.chromeState.set('full');
  shell.restartRecedeTimer();
}

/** pointercancel (e.g. stylus removed, browser-interrupted gesture): mirror
 *  pointerup cleanup but do NOT commit the interrupted value — just restore
 *  chrome state and release the listeners. */
function onScrubCancel(shell: EditorShellComponent, scrub: ScrubGestureState): void {
  shell.editorState.cancelGesture();
  cleanupScrub(shell, scrub);
  shell.hudVisible.set(false);
  shell.chromeState.set('full');
  shell.restartRecedeTimer();
}

export function cleanupScrub(shell: EditorShellComponent, scrub: ScrubGestureState): void {
  shell.scrubbing.set(false);
  scrub.pointerId = null;
  scrub.startModel = null;
  if (scrub.moveBound) {
    window.removeEventListener('pointermove', scrub.moveBound);
    scrub.moveBound = null;
  }
  if (scrub.upBound) {
    window.removeEventListener('pointerup', scrub.upBound);
    scrub.upBound = null;
  }
  if (scrub.cancelBound) {
    window.removeEventListener('pointercancel', scrub.cancelBound);
    scrub.cancelBound = null;
  }
}
