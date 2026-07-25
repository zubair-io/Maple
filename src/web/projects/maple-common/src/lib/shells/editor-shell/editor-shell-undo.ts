// Undo / redo long-press gesture for EditorShellComponent (#1816).
// Extracted from the component to keep editor-shell.component.ts under the
// per-file LOC budget, following the same shape as `editor-shell-scrub.ts`
// and `editor-shell-chrome.ts`: a mutable state bag the shell owns, passed
// by reference, plus free functions that operate on the live component
// through its public surface. `import type` keeps this a type-only (no
// runtime) dependency on the shell.
//
// Long-press → redo, tap → undo. Mirrors the S5 editor's header button
// (`editor-header.component.ts`) so both editors share the same gesture.
import type { EditorShellComponent } from './editor-shell.component';

/** How long the button must be held before the press counts as redo. */
const LONG_PRESS_MS = 500;

/** Mutable long-press bookkeeping, owned by the shell and passed by
 *  reference so the fields don't have to live on the component class
 *  (they aren't template-visible). */
export interface UndoLongPressState {
  timer: ReturnType<typeof setTimeout> | null;
  longPressed: boolean;
}

export function newUndoLongPressState(): UndoLongPressState {
  return { timer: null, longPressed: false };
}

/** Captures the pointer on the button itself (#1816 review) so a drag-off
 *  release still delivers `pointerup` HERE rather than to whatever element
 *  is now under the pointer — without capture, a press-drag-release outside
 *  the button's bounds never fires `onUndoPointerUp`, so the long-press
 *  timer never clears and redo() fires despite the pointer having left the
 *  button. Guarded: not every pointer environment implements
 *  `setPointerCapture` (e.g. jsdom in tests). */
export function onUndoPointerDown(
  shell: EditorShellComponent,
  undo: UndoLongPressState,
  e: PointerEvent,
): void {
  undo.longPressed = false;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture?.(e.pointerId);
  undo.timer = setTimeout(() => {
    undo.longPressed = true;
    shell.editorState.redo();
  }, LONG_PRESS_MS);
}

export function onUndoPointerUp(shell: EditorShellComponent, undo: UndoLongPressState): void {
  clearUndoTimer(undo);
  if (!undo.longPressed) shell.editorState.undo();
}

export function onUndoPointerCancel(undo: UndoLongPressState): void {
  clearUndoTimer(undo);
}

function clearUndoTimer(undo: UndoLongPressState): void {
  if (undo.timer) {
    clearTimeout(undo.timer);
    undo.timer = null;
  }
}
