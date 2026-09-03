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
import {
  type EditorIntent,
  commandForKey,
  isValueWidgetChord,
  EDITOR_COMMANDS,
} from './editor-commands';

/** A tap shorter than this on the before/after control toggles the latched
 *  split; a longer hold is a momentary peek that ends on release. */
export const COMPARE_HOLD_MS = 300;

/** Mutable router bookkeeping the shell owns (same shape as the scrub /
 *  undo state bags). */
export interface CommandRouterState {
  /** `performance.now()` of the current before/after press, or null. */
  comparePressedAt: number | null;
  /** Asset the before/after press started on — a release for another
   *  asset ends the peek without toggling its split. */
  compareAssetId: string | null;
  /** Asset the command menu was opened on, while it is open. */
  menuAssetId: string | null;
}

export function newCommandRouterState(): CommandRouterState {
  return { comparePressedAt: null, compareAssetId: null, menuAssetId: null };
}

export type FocusContext = 'text' | 'value-widget' | 'menu' | 'dialog' | 'none';

/** What the event's target owns. A modal dialog (the export options) owns
 *  every key, so Escape closes it rather than leaving the editor. */
export function focusContextOf(target: EventTarget | null, menuOpen: boolean): FocusContext {
  if (!(target instanceof HTMLElement)) return menuOpen ? 'menu' : 'none';
  if (target.closest('[aria-modal="true"]')) return 'dialog';
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
  if (context === 'text' || context === 'dialog') return null;
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

type Handler<K extends EditorIntent['kind']> = (
  shell: EditorShellComponent,
  router: CommandRouterState,
  intent: Extract<EditorIntent, { kind: K }>,
) => boolean;

const navigate = (shell: EditorShellComponent, direction: 'prev' | 'next'): boolean => {
  const fid = shell.state.focusedAssetId();
  if (!fid || gestureInFlight(shell)) return false;
  const target = direction === 'prev' ? shell.state.peekPrev(fid) : shell.state.peekNext(fid);
  if (target) shell.navigateToAsset(target);
  return target !== null;
};

const withAsset = (shell: EditorShellComponent, act: (fid: string) => void): boolean => {
  const fid = shell.state.focusedAssetId();
  if (!fid) return false;
  act(fid);
  return true;
};

/** One handler per intent kind — each a few lines, so the table reads as
 *  the contract and no single function carries the whole switch. */
const HANDLERS: { [K in EditorIntent['kind']]: Handler<K> } = {
  'nav.back': (shell) => (shell.goBack(), true),
  'nav.prev': (shell) => navigate(shell, 'prev'),
  'nav.next': (shell) => navigate(shell, 'next'),
  'sidecar.flush': (shell) => (void shell.state.flushPendingXmpWrites(), true),
  'history.undo': (shell) => (shell.editorState.undo(), true),
  'history.redo': (shell) => (shell.editorState.redo(), true),
  'clipboard.copy': (shell) => {
    const id = shell.editorState.imageId();
    const model = shell.editorState.currentAdjustment();
    if (id == null || model == null) return false;
    shell.clipboard.copyFrom(id, shell.assetName(), model);
    return true;
  },
  'tool.cycle': (shell, _r, intent) => (cycleTool(shell, intent.direction, intent.byGroup), true),
  'tool.group': (shell, _r, intent) => (shell.onGroupChange(intent.group), true),
  'value.nudge': (shell, _r, intent) => {
    if (!shell.editorState.armedToolAcceptsValueEdits()) return false;
    const cur = shell.editorState.armedInternalValue();
    shell.editorState.commit();
    shell.editorState.setArmedInternalValue(
      Math.min(100, Math.max(-100, cur + intent.direction * 10)),
    );
    return true;
  },
  'value.reset-group': (shell) => (shell.controlCard?.resetGroup(), true),
  'asset.rating': (shell, _r, intent) =>
    withAsset(shell, (fid) => shell.state.setRating(fid, intent.rating)),
  'asset.flag': (shell, _r, intent) =>
    withAsset(shell, (fid) => {
      const current = shell.state.focusedAsset()?.flag;
      const flag =
        current === intent.flag && intent.flag !== 'unflagged' ? 'unflagged' : intent.flag;
      shell.state.setFlag(fid, flag);
    }),
  'compare.press': (shell, router) => {
    if (router.comparePressedAt !== null) return false;
    router.comparePressedAt = performance.now();
    router.compareAssetId = shell.state.focusedAssetId();
    shell.canvasSvc.beginPeekBefore();
    return true;
  },
  'compare.release': (shell, router) => {
    if (router.comparePressedAt === null) return false;
    const held = performance.now() - router.comparePressedAt;
    const sameAsset = router.compareAssetId === shell.state.focusedAssetId();
    router.comparePressedAt = null;
    router.compareAssetId = null;
    shell.canvasSvc.endPeekBefore();
    // The press belonged to another image: end the peek, never latch here.
    if (sameAsset && held < COMPARE_HOLD_MS) shell.canvasSvc.toggleBeforeAfter();
    return sameAsset;
  },
  'zoom.fit': (shell) => (shell.canvasSvc.zoomToFit(), true),
  'zoom.100': (shell) => (shell.canvasSvc.zoomTo100(), true),
  'zoom.step': (shell, _r, intent) => (shell.canvasSvc.requestStepZoom(intent.direction), true),
  'chrome.sidebar': (shell) => (shell.state.toggleSidebar(), true),
  'chrome.inspector': (shell) => (shell.state.toggleInspector(), true),
  'panel.scopes': (shell) => (shell.onScopesPanelToggle(), true),
  'commands.menu': (shell, router) => {
    const open = !shell.commandMenuOpen();
    router.menuAssetId = open ? shell.state.focusedAssetId() : null;
    shell.commandMenuOpen.set(open);
    return true;
  },
};

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
  const assetBound = intent.kind !== 'nav.back' && intent.kind !== 'commands.menu';
  if (assetBound && bound.assetId !== shell.state.focusedAssetId()) return false;
  return (HANDLERS[intent.kind] as Handler<typeof intent.kind>)(shell, router, intent);
}

/** The command menu picked `id`: run it for the asset the menu was opened
 *  on — a pick after a filmstrip switch is a stale command and is refused. */
export function selectMenuCommand(
  shell: EditorShellComponent,
  router: CommandRouterState,
  id: string,
): boolean {
  const command = EDITOR_COMMANDS.find((c) => c.id === id);
  const assetId = router.menuAssetId;
  shell.commandMenuOpen.set(false);
  router.menuAssetId = null;
  return command ? executeIntent(shell, router, { intent: command.intent, assetId }) : false;
}

/** The before/after button's press: capture the pointer so a drag-off
 *  release still lands here, then the same press intent the keys use. */
export function comparePointerDown(
  shell: EditorShellComponent,
  router: CommandRouterState,
  e: PointerEvent,
): void {
  (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  executeIntent(shell, router, bind(shell, { kind: 'compare.press' }));
}

export function comparePointerUp(shell: EditorShellComponent, router: CommandRouterState): void {
  executeIntent(shell, router, bind(shell, { kind: 'compare.release' }));
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
  router.compareAssetId = null;
  shell.canvasSvc.endPeekBefore();
}
