// editor-command-router.ts — the web editor's command router (#2450,
// milestone 18 design spec §3.3). One place resolves an input into an
// intent and one place executes an intent, against:
//
//   - FOCUS CONTEXT — a text field owns every key; a focused value widget
//     (`role="slider"` / `role="spinbutton"`) owns its bare arrow / Home /
//     End keys and nothing else (#2409); an open command menu owns
//     everything but Escape;
//   - the ACTIVE SUBTOOL — value commands are refused while the armed tool
//     takes no value edits (Crop, Presets);
//   - the ASSET GENERATION — an intent is bound to the asset it was
//     resolved for and refused if the shell has moved on (a command menu
//     opened on one image, chosen after a filmstrip click);
//   - GESTURE STATE — navigation is refused while a scrub, slider drag or
//     wheel burst is in flight, so an uncommitted interaction can never be
//     carried onto another asset (`EditorStateService.bind()` also discards
//     any parked commit-on-release value on the switch);
//   - INPUT SOURCE — the same intent from a key, the command menu or a
//     button lands identically; momentary vs latched before/after is one
//     press/release pair whichever input pressed it.
//
// Preview cancellation stays with the render generation counter
// (image-canvas.two-phase.ts); commit boundaries stay with
// `EditorStateService.commit()`/`beginGesture()`/`endGesture()` — the router
// consumes both, it does not add a second scheduler.

import type { EditorShellComponent } from './editor-shell.component';
import { type ToolGroup, type ToolId, groupOf, visibleToolsInGroup } from '../../editor/tool-model';
import { type EditorIntent, commandForKey, isValueWidgetChord } from './editor-commands';

/** A tap shorter than this on the before/after control toggles the latched
 *  split; a longer hold is a momentary peek that ends on release. */
export const COMPARE_HOLD_MS = 300;

/** Mutable router bookkeeping the shell owns (same shape as the scrub /
 *  undo state bags). */
export interface CommandRouterState {
  /** `performance.now()` of the current before/after press, or null. */
  comparePressedAt: number | null;
}

export function newCommandRouterState(): CommandRouterState {
  return { comparePressedAt: null };
}

export type FocusContext = 'text' | 'value-widget' | 'menu' | 'none';

/** What the event's target owns. */
export function focusContextOf(target: EventTarget | null, menuOpen: boolean): FocusContext {
  if (!(target instanceof HTMLElement)) return menuOpen ? 'menu' : 'none';
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  ) {
    return menuOpen && target.closest('mui-command-menu') ? 'menu' : 'text';
  }
  if (menuOpen) return 'menu';
  return target.closest('[role="slider"], [role="spinbutton"]') ? 'value-widget' : 'none';
}

/** An intent bound to the asset it was resolved for. */
export interface BoundIntent {
  readonly intent: EditorIntent;
  readonly assetId: string | null;
}

/**
 * Resolve a keydown to an intent, or `null` when the focus context owns the
 * key. Pure: no side effects, no DOM writes.
 */
export function resolveKeydown(shell: EditorShellComponent, e: KeyboardEvent): BoundIntent | null {
  const context = focusContextOf(e.target, shell.commandMenuOpen());
  if (context === 'text') return null;
  if (context === 'menu') {
    return e.key === 'Escape' ? bind(shell, { kind: 'commands.menu' }) : null;
  }
  if (context === 'value-widget' && isValueWidgetChord(e)) return null;
  const command = commandForKey(e);
  if (!command) return null;
  // A held key auto-repeats; the before/after press is a single gesture.
  if (command.intent.kind === 'compare.press' && e.repeat) return null;
  return bind(shell, command.intent);
}

/** Resolve a keyup: only the before/after release cares. */
export function resolveKeyup(shell: EditorShellComponent, e: KeyboardEvent): BoundIntent | null {
  const command = commandForKey(e);
  if (command?.intent.kind !== 'compare.press') return null;
  return bind(shell, { kind: 'compare.release' });
}

export function bind(shell: EditorShellComponent, intent: EditorIntent): BoundIntent {
  return { intent, assetId: shell.state.focusedAssetId() };
}

/** True while any continuous value gesture is in flight. */
function gestureInFlight(shell: EditorShellComponent): boolean {
  return shell.scrubbing() || shell.editorState.gestureActive();
}

/**
 * Execute a bound intent. Returns `false` when the router refused it — the
 * asset changed since it was resolved, or a gesture owns the editor.
 */
export function executeIntent(
  shell: EditorShellComponent,
  router: CommandRouterState,
  bound: BoundIntent,
): boolean {
  const { intent } = bound;
  const stale = bound.assetId !== shell.state.focusedAssetId();
  // Asset-bound intents must land on the asset they were resolved for.
  if (stale && intent.kind !== 'nav.back' && intent.kind !== 'commands.menu') return false;
  const fid = shell.state.focusedAssetId();

  switch (intent.kind) {
    case 'nav.back':
      shell.goBack();
      return true;
    case 'nav.prev':
    case 'nav.next': {
      if (!fid || gestureInFlight(shell)) return false;
      const target =
        intent.kind === 'nav.prev' ? shell.state.peekPrev(fid) : shell.state.peekNext(fid);
      if (target) shell.navigateToAsset(target);
      return target !== null;
    }
    case 'sidecar.flush':
      void shell.state.flushPendingXmpWrites();
      return true;
    case 'history.undo':
      shell.editorState.undo();
      return true;
    case 'history.redo':
      shell.editorState.redo();
      return true;
    case 'clipboard.copy': {
      const id = shell.editorState.imageId();
      const model = shell.editorState.currentAdjustment();
      if (id == null || model == null) return false;
      shell.clipboard.copyFrom(id, shell.assetName(), model);
      return true;
    }
    case 'tool.cycle':
      cycleTool(shell, intent.direction, intent.byGroup);
      return true;
    case 'tool.group':
      shell.onGroupChange(intent.group);
      return true;
    case 'value.nudge': {
      if (!shell.editorState.armedToolAcceptsValueEdits()) return false;
      const cur = shell.editorState.armedInternalValue();
      const next = Math.min(100, Math.max(-100, cur + intent.direction * 10));
      shell.editorState.commit();
      shell.editorState.setArmedInternalValue(next);
      return true;
    }
    case 'value.reset-group':
      shell.controlCard?.resetGroup();
      return true;
    case 'asset.rating':
      if (!fid) return false;
      shell.state.setRating(fid, intent.rating);
      return true;
    case 'asset.flag': {
      if (!fid) return false;
      const asset = shell.state.focusedAsset();
      const flag =
        asset?.flag === intent.flag && intent.flag !== 'unflagged' ? 'unflagged' : intent.flag;
      shell.state.setFlag(fid, flag);
      return true;
    }
    case 'compare.press':
      if (router.comparePressedAt !== null) return false;
      router.comparePressedAt = performance.now();
      shell.canvasSvc.beginPeekBefore();
      return true;
    case 'compare.release': {
      if (router.comparePressedAt === null) return false;
      const held = performance.now() - router.comparePressedAt;
      router.comparePressedAt = null;
      shell.canvasSvc.endPeekBefore();
      if (held < COMPARE_HOLD_MS) shell.canvasSvc.toggleBeforeAfter();
      return true;
    }
    case 'zoom.fit':
      shell.canvasSvc.zoomToFit();
      return true;
    case 'zoom.100':
      shell.canvasSvc.zoomTo100();
      return true;
    case 'zoom.step':
      shell.canvasSvc.requestStepZoom(intent.direction);
      return true;
    case 'chrome.sidebar':
      shell.state.toggleSidebar();
      return true;
    case 'chrome.inspector':
      shell.state.toggleInspector();
      return true;
    case 'panel.scopes':
      shell.onScopesPanelToggle();
      return true;
    case 'commands.menu':
      shell.commandMenuOpen.update((open) => !open);
      return true;
  }
}

/** Cycle the armed tool within its group; `byGroup` cycles the group. */
function cycleTool(shell: EditorShellComponent, direction: 1 | -1, byGroup: boolean): void {
  if (byGroup) {
    const groups: readonly ToolGroup[] = ['light', 'color', 'effects', 'detail'];
    const i = groups.indexOf(shell.editorState.armedGroup());
    shell.onGroupChange(groups[(i + direction + groups.length) % groups.length]);
    return;
  }
  // visibleToolsInGroup (#276) drops `hsl` from the cycle while Black &
  // White is On — its surface is hidden, so cycling must never land there.
  const blackWhiteOn = shell.editorState.currentAdjustment()?.blackWhite === 'On';
  const tools: readonly ToolId[] = visibleToolsInGroup(
    groupOf(shell.editorState.armedTool()),
    blackWhiteOn,
  );
  const i = tools.indexOf(shell.editorState.armedTool());
  shell.onToolChange(tools[(i + direction + tools.length) % tools.length]);
}

/** Abandon an in-flight before/after press (pointer cancel, teardown). */
export function cancelCompare(shell: EditorShellComponent, router: CommandRouterState): void {
  if (router.comparePressedAt === null) return;
  router.comparePressedAt = null;
  shell.canvasSvc.endPeekBefore();
}
