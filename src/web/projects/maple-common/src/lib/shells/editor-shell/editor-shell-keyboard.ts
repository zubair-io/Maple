// Keyboard-shortcut dispatch for EditorShellComponent (#1535).
// Extracted from the component to keep editor-shell.component.ts under the
// per-file LOC budget. Operates on the live component via its public surface;
// `import type` keeps this a type-only (no runtime) dependency on the shell.
//
// Save / undo / redo / cycle-tool shortcuts (epic #1807 slice 5) are ported
// verbatim from the S5 editor's `editor.component.ts` `onKey` handler so both
// editors share the same muscle memory. B's bare `0` (reset armed tool) is
// NOT ported here — A's `0` already does something else (clear rating, see
// below), and that binding is real, working, and came first in this shell.
import type { EditorShellComponent } from './editor-shell.component';
import { type ToolGroup, type ToolId, groupOf, visibleToolsInGroup } from '../../editor/tool-model';

/** Cycle the armed tool within its group; shift cycles the group. Verbatim
 * port of the S5 editor's `_nudgeTool` (`editor.component.ts`). */
function nudgeTool(shell: EditorShellComponent, direction: 1 | -1, byGroup: boolean): void {
  if (byGroup) {
    const groups: readonly ToolGroup[] = ['light', 'color', 'effects', 'detail'];
    const i = groups.indexOf(shell.editorState.armedGroup());
    const next = groups[(i + direction + groups.length) % groups.length];
    shell.onGroupChange(next);
    return;
  }
  // visibleToolsInGroup (#276) drops `hsl` from the cycle order while Black
  // & White is On — its surface is hidden (dock entry + panel), so cycling
  // must never land the armed tool there.
  const blackWhiteOn = shell.editorState.currentAdjustment()?.blackWhite === 'On';
  const tools: readonly ToolId[] = visibleToolsInGroup(
    groupOf(shell.editorState.armedTool()),
    blackWhiteOn,
  );
  const i = tools.indexOf(shell.editorState.armedTool());
  const next = tools[(i + direction + tools.length) % tools.length];
  shell.onToolChange(next);
}

/**
 * Pro editor keyboard shortcuts (spec §13). Bound from the shell's
 * `@HostListener('document:keydown')`. Returns early when the event target is
 * a text field so typing isn't hijacked.
 */
export function handleEditorKeydown(shell: EditorShellComponent, e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
    return;

  const fid = shell.state.focusedAssetId();
  const meta = e.metaKey || e.ctrlKey;

  // Esc — back to browse
  if (e.key === 'Escape') {
    shell.goBack();
    e.preventDefault();
    return;
  }

  // ⌘S / Ctrl+S — flush pending XMP writes now (mirrors the S5 editor).
  // Excludes ⌘⌥S (toggle sidebar, handled below) via the `!e.altKey` guard.
  if (meta && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    void shell.state.flushPendingXmpWrites();
    return;
  }

  // ⌘Z / Ctrl+Z — undo. ⌘⇧Z / Ctrl+Shift+Z — redo. Mirrors the S5 editor.
  if (meta && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) shell.editorState.redo();
    else shell.editorState.undo();
    return;
  }

  // ⌘C / Ctrl+C — copy the open image's develop settings into the app
  // clipboard (#944), so "copy from the image you're editing" works
  // without going back to Browse. Paste happens from the Browse toolbar /
  // shortcuts against a multi-selection — there is no paste target here.
  if (meta && !e.altKey && (e.key === 'c' || e.key === 'C')) {
    const id = shell.editorState.imageId();
    const model = shell.editorState.currentAdjustment();
    if (id != null && model != null) {
      shell.clipboard.copyFrom(id, shell.assetName(), model);
    }
    e.preventDefault();
    return;
  }

  // [ / ] — cycle the armed tool within its group; Shift cycles the group.
  // Mirrors the S5 editor's `_nudgeTool`.
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    nudgeTool(shell, e.key === ']' ? 1 : -1, e.shiftKey);
    return;
  }

  // Arrow navigation / slider nudge (Pro spec §13):
  //   ← / →             (bare)       — navigate prev / next image
  //   Shift + ← / →                  — nudge armed slider ±10
  //
  // The two behaviors are mutually exclusive by modifier key, so there
  // is no ambiguity and no dead code path.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey) {
    if (e.shiftKey) {
      // Shift+Arrow — nudge the armed slider ±10 internal units
      if (shell.editorState.armedToolAcceptsValueEdits()) {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const cur = shell.editorState.armedInternalValue();
        const next = Math.min(100, Math.max(-100, cur + dir * 10));
        shell.editorState.commit();
        shell.editorState.setArmedInternalValue(next);
      }
    } else {
      // Bare Arrow — navigate prev / next
      if (fid) {
        if (e.key === 'ArrowLeft') {
          const prev = shell.state.peekPrev(fid);
          if (prev) shell.navigateToAsset(prev);
        } else {
          const next = shell.state.peekNext(fid);
          if (next) shell.navigateToAsset(next);
        }
      }
    }
    e.preventDefault();
    return;
  }

  // 1–4: switch tool group (bare, no meta)
  if (!meta && ['1', '2', '3', '4'].includes(e.key)) {
    const groups: ToolGroup[] = ['light', 'color', 'effects', 'detail'];
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < groups.length) {
      shell.onGroupChange(groups[idx]);
      e.preventDefault();
      return;
    }
  }

  // 5: star rating
  if (!meta && e.key === '5' && fid) {
    shell.state.setRating(fid, 5);
    e.preventDefault();
    return;
  }

  // 0: clear rating
  if (!meta && e.key === '0' && fid) {
    shell.state.setRating(fid, 0);
    e.preventDefault();
    return;
  }

  // P: pick
  if ((e.key === 'p' || e.key === 'P') && fid) {
    const asset = shell.state.focusedAsset();
    if (asset) shell.state.setFlag(fid, asset.flag === 'pick' ? 'unflagged' : 'pick');
    e.preventDefault();
    return;
  }

  // X: reject
  if ((e.key === 'x' || e.key === 'X') && fid) {
    const asset = shell.state.focusedAsset();
    if (asset) shell.state.setFlag(fid, asset.flag === 'reject' ? 'unflagged' : 'reject');
    e.preventDefault();
    return;
  }

  // U: clear flag
  if ((e.key === 'u' || e.key === 'U') && fid) {
    shell.state.setFlag(fid, 'unflagged');
    e.preventDefault();
    return;
  }

  // \ or b: toggle before/after
  if (e.key === '\\' || e.key === 'b' || e.key === 'B') {
    shell.canvasSvc.toggleBeforeAfter();
    e.preventDefault();
    return;
  }

  // R: reset armed group — delegates to ControlCard which owns group state
  if ((e.key === 'r' || e.key === 'R') && !meta) {
    shell.controlCard?.resetGroup();
    e.preventDefault();
    return;
  }

  // F: fit
  if ((e.key === 'f' || e.key === 'F') && !meta) {
    shell.canvasSvc.zoomToFit();
    e.preventDefault();
    return;
  }

  // Z: 1:1
  if ((e.key === 'z' || e.key === 'Z') && !meta) {
    shell.canvasSvc.zoomTo100();
    e.preventDefault();
    return;
  }

  // ⌘⌥S / Ctrl+Alt+S — toggle sidebar/filmstrip
  if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
    shell.state.toggleSidebar();
    e.preventDefault();
    return;
  }

  // ⌘⌥D / Ctrl+Alt+D — toggle inspector
  if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
    shell.state.toggleInspector();
    e.preventDefault();
    return;
  }
}
