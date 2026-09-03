// editor-shell-wheel.ts — scroll-wheel slider nudge for EditorShellComponent
// (#2450). Closes the one native-only input primitive the milestone 18 spec
// records (§2.2): Apple nudges the armed tool from `CanvasZoomHost` →
// `EditorState.wheelNudge` → `WheelNudgeBurst`; this is the web
// implementation of the same contract, scoped to the current shell (the
// retired S5 handler is not resurrected).
//
// Ownership: `CanvasZoomGestures` (image-canvas.zoom-gestures.ts) sees the
// wheel first and `preventDefault`s what it consumes — ⌘/Ctrl+wheel and
// trackpad pinch (zoom), plain wheel while zoomed (pan). A plain wheel at
// fit zoom reaches here unconsumed and nudges the armed (tool, sub-param).
//
// Contract (mirrors Apple):
//   - detents: one step per line/page-mode tick; pixel-mode deltas
//     accumulate and emit a step every DETENT_PX;
//   - unit: 1 internal unit per detent, ⇧ = 10, ⌥ = 0.1;
//   - undo: detents within BURST_MS on the same (tool, sub-param) share one
//     undo entry — a pause, or a change of target, starts a new burst;
//   - commit-on-release fields (Noise → Deep / Prefilter) park the value
//     for the burst and flush FLUSH_MS after the last detent, so a decode
//     never runs per detent.

import type { EditorShellComponent } from './editor-shell.component';
import type { ToolId } from '../../editor/tool-model';

export const DETENT_PX = 20;
export const BURST_MS = 500;
export const FLUSH_MS = 250;

export interface WheelNudgeState {
  accumulatedPx: number;
  lastAt: number;
  lastTool: ToolId | null;
  lastSubParam: string | null;
  /** Asset the burst is nudging — a focus switch always starts a new burst. */
  lastAssetId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export function newWheelNudgeState(): WheelNudgeState {
  return {
    accumulatedPx: 0,
    lastAt: 0,
    lastTool: null,
    lastSubParam: null,
    lastAssetId: null,
    flushTimer: null,
  };
}

/** Whole detents represented by this event (positive = increase). */
export function detentsFor(state: WheelNudgeState, e: WheelEvent): number {
  if (e.deltaY === 0) return 0;
  if (e.deltaMode !== 0) return e.deltaY < 0 ? 1 : -1;
  state.accumulatedPx += e.deltaY;
  const steps = Math.trunc(state.accumulatedPx / DETENT_PX);
  state.accumulatedPx -= steps * DETENT_PX;
  return -steps;
}

export function unitFor(e: Pick<WheelEvent, 'shiftKey' | 'altKey'>): number {
  return e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
}

/** Wheel on the canvas layer — nudges the armed tool at fit zoom. */
export function onCanvasWheel(
  shell: EditorShellComponent,
  state: WheelNudgeState,
  e: WheelEvent,
  now: number = performance.now(),
): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
  if (shell.canvasSvc.pixelScale() !== 0) return;
  const editorState = shell.editorState;
  if (!editorState.armedToolAcceptsValueEdits()) return;
  e.preventDefault();
  const steps = detentsFor(state, e);
  if (steps === 0) return;

  const tool = editorState.armedTool();
  const subParam = editorState.armedSubParamId();
  const assetId = editorState.imageId();
  const newBurst =
    tool !== state.lastTool ||
    subParam !== state.lastSubParam ||
    assetId !== state.lastAssetId ||
    now - state.lastAt > BURST_MS;
  if (newBurst) editorState.commit();
  state.lastAt = now;
  state.lastTool = tool;
  state.lastSubParam = subParam;
  state.lastAssetId = assetId;

  const commitsOnRelease = editorState.armedCommitsOnRelease();
  if (commitsOnRelease) editorState.beginGesture();
  const next = editorState.armedInternalValue() + steps * unitFor(e);
  editorState.setArmedInternalValue(Math.min(100, Math.max(-100, next)));
  shell.showHud();
  shell.scheduleHudFade();
  if (commitsOnRelease) scheduleFlush(shell, state);
}

function scheduleFlush(shell: EditorShellComponent, state: WheelNudgeState): void {
  if (state.flushTimer !== null) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    shell.editorState.endGesture();
  }, FLUSH_MS);
}

/** Teardown: write a parked burst value now rather than losing it. */
export function cleanupWheel(shell: EditorShellComponent, state: WheelNudgeState): void {
  if (state.flushTimer === null) return;
  clearTimeout(state.flushTimer);
  state.flushTimer = null;
  shell.editorState.endGesture();
}
