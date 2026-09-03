// editor-shell-panels.ts — floating-panel mutual exclusion for
// EditorShellComponent (#2449). Extracted from the component to keep it
// under the per-file LOC budget, same shape as editor-shell-scrub.ts /
// editor-shell-undo.ts: free functions over the shell's public surface,
// `import type` so this stays a type-only dependency on the shell.
//
// The rule these encode: Curve, Presets, Scopes, Crop and the Noise
// sub-param panel all share ONE dock-side anchor on tablet/desktop (and the
// slider card's anchor slot on phone), and the control card hides while any
// of them is open (`.control-card-anchor`'s `@if` guard in the template) —
// so at most one is open at a time, Crop (an armed tool with a
// full-replacement toolbar) blocks the toggles, and arming a tool that
// renders INSIDE the card closes every panel so the card, and the tool just
// armed, become visible again immediately.

import type { EditorShellComponent } from './editor-shell.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';

/** Tools whose control surface lives in (or replaces) the control card:
 *  Crop replaces it with the crop toolbar; the rest render inside it via
 *  content projection (`cardBodySubParam` / `cardBodyGrade` /
 *  `cardBodyFilm` / `cardBodyLens`). Arming any of them closes the open
 *  panel so the card is visible again. */
const CARD_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'crop',
  'hsl',
  'bwMix',
  'colorGrade',
  'filmLook',
  'lensCorrections',
]);

/** Close every dock-side / phone flyout panel. */
function closePanels(shell: EditorShellComponent): void {
  shell.curveOpen.set(false);
  shell.presetsOpen.set(false);
  shell.scopesOpen.set(false);
}

/** Arm a specific tool (dock entry or sub-tool chip). Tapping always arms;
 *  exiting Crop is an explicit action (the crop toolbar's Done), the
 *  card-body tools simply stay armed until another tool is picked. */
export function armTool(shell: EditorShellComponent, tool: ToolId): void {
  if (CARD_TOOLS.has(tool)) closePanels(shell);
  shell.editorState.armTool(tool);
  shell.editorState.haptic('switch');
}

/** Toggle one panel, closing the other two; a no-op while Crop owns the anchor. */
function togglePanel(
  shell: EditorShellComponent,
  panel: 'curveOpen' | 'presetsOpen' | 'scopesOpen',
): void {
  if (shell.cropArmed()) return;
  const wasOpen = shell[panel]();
  closePanels(shell);
  shell[panel].set(!wasOpen);
}

export function toggleCurve(shell: EditorShellComponent): void {
  togglePanel(shell, 'curveOpen');
}

export function togglePresets(shell: EditorShellComponent): void {
  togglePanel(shell, 'presetsOpen');
}

export function toggleScopes(shell: EditorShellComponent): void {
  togglePanel(shell, 'scopesOpen');
}

/** Phone bottom dock (#1807 Task 5): a group tap must also close an open
 *  panel, because the always-visible slider card and the panels float in
 *  the same anchor slot above the dock — `onGroupChange` alone never
 *  touches the panel signals (review round 2: a group tap while Presets
 *  was open left the card hidden underneath it). */
export function phoneDockGroupChange(shell: EditorShellComponent, group: ToolGroup): void {
  closePanels(shell);
  shell.onGroupChange(group);
}
