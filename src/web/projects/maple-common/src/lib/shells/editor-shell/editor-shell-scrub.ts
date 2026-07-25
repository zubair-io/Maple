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

/** Mutable scrub-gesture bookkeeping, owned by the shell and passed by
 *  reference so this module can read/write it without the fields living
 *  directly on the component class (they aren't template-visible). */
export interface ScrubGestureState {
  startX: number;
  startInternal: number;
  moveBound: ((e: PointerEvent) => void) | null;
  upBound: ((e: PointerEvent) => void) | null;
  cancelBound: ((e: PointerEvent) => void) | null;
}

export function newScrubGestureState(): ScrubGestureState {
  return { startX: 0, startInternal: 0, moveBound: null, upBound: null, cancelBound: null };
}

/** pointerdown on the canvas layer — starts the scrub gesture. Only scrubs
 *  at fit zoom (pixelScale === 0), primary button only, and only when the
 *  armed tool accepts value edits (e.g. not while Crop is armed). */
export function onCanvasPointerDown(
  shell: EditorShellComponent,
  scrub: ScrubGestureState,
  e: PointerEvent,
): void {
  if (e.button !== 0) return;
  if (shell.canvasSvc.pixelScale() !== 0) return;
  if (!shell.editorState.armedToolAcceptsValueEdits()) return;

  const wrap = shell.canvasWrapRef?.nativeElement;
  if (!wrap) return;

  e.preventDefault();
  scrub.startX = e.clientX;
  scrub.startInternal = shell.editorState.armedInternalValue();

  shell.editorState.commit();
  // Commit-on-release sub-params (Noise → Deep / Prefilter, #1153) park their
  // value for the duration of the gesture instead of re-developing per move.
  shell.editorState.beginGesture();
  shell.scrubbing.set(true);
  shell.chromeState.set('scrubbing');
  shell.showHud();

  scrub.moveBound = (ev: PointerEvent) => onScrubMove(shell, scrub, ev);
  scrub.upBound = (ev: PointerEvent) => onScrubUp(shell, scrub, ev);
  scrub.cancelBound = (_ev: PointerEvent) => onScrubCancel(shell, scrub);
  window.addEventListener('pointermove', scrub.moveBound);
  window.addEventListener('pointerup', scrub.upBound);
  window.addEventListener('pointercancel', scrub.cancelBound);
  wrap.setPointerCapture(e.pointerId);
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
