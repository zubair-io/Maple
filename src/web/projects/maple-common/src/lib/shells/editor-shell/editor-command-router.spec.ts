// editor-command-router.spec.ts — the router's own rules (#2450): focus
// context resolution, stale-asset refusal, the gesture guard on navigation,
// and the momentary/latched before/after press-release contract. The key →
// intent mapping for every chord is exercised through the keyboard seam in
// editor-shell-keyboard.spec.ts; this file drives `executeIntent` directly.

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { EditorShellComponent } from './editor-shell.component';
import {
  COMPARE_HOLD_MS,
  cancelCompare,
  compareActivate,
  executeIntent,
  focusContextOf,
  newCommandRouterState,
  resolveKeydown,
} from './editor-command-router';
import { ariaKeyshortcuts, chordMatches, describeChord, EDITOR_COMMANDS } from './editor-commands';
import { newWheelNudgeState } from './editor-shell-wheel';

function makeShell(assetId: string | null = 'a.dng') {
  const focused = signal<string | null>(assetId);
  return {
    state: {
      focusedAssetId: () => focused(),
      focusedAsset: () => ({ flag: 'pick' }),
      setRating: vi.fn(),
      setFlag: vi.fn(),
      peekPrev: vi.fn(() => 'z.dng'),
      peekNext: vi.fn(() => 'b.dng'),
      toggleSidebar: vi.fn(),
      toggleInspector: vi.fn(),
      flushPendingXmpWrites: vi.fn(() => Promise.resolve()),
    },
    editorState: {
      armedGroup: signal('light'),
      armedTool: signal('exposure'),
      armedToolAcceptsValueEdits: () => true,
      armedInternalValue: () => 0,
      armedSubParamId: () => null,
      currentAdjustment: () => ({ blackWhite: 'Off' }),
      imageId: () => focused(),
      commit: vi.fn(),
      setArmedInternalValue: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      gestureActive: () => false,
    },
    canvasSvc: {
      toggleBeforeAfter: vi.fn(),
      beginPeekBefore: vi.fn(),
      endPeekBefore: vi.fn(),
      zoomToFit: vi.fn(),
      zoomTo100: vi.fn(),
      requestStepZoom: vi.fn(),
    },
    clipboard: { copyFrom: vi.fn() },
    assetName: () => 'a.dng',
    controlCard: { resetGroup: vi.fn() },
    commandMenuOpen: signal(false),
    wheelNudge: newWheelNudgeState(),
    scrubbing: () => false,
    goBack: vi.fn(),
    navigateToAsset: vi.fn(),
    onGroupChange: vi.fn(),
    onToolChange: vi.fn(),
    onScopesPanelToggle: vi.fn(),
    focused,
  };
}

const asShell = (s: ReturnType<typeof makeShell>) => s as unknown as EditorShellComponent;

describe('focusContextOf', () => {
  it('classifies text fields, value widgets, the open menu and plain targets', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    const thumb = document.createElement('span');
    slider.append(thumb);
    expect(focusContextOf(input, false)).toBe('text');
    expect(focusContextOf(area, false)).toBe('text');
    expect(focusContextOf(editable, false)).toBe('text');
    expect(focusContextOf(thumb, false)).toBe('value-widget');
    expect(focusContextOf(document.body, false)).toBe('none');
    expect(focusContextOf(document.body, true)).toBe('menu');
    expect(focusContextOf(null, false)).toBe('none');
  });

  it('lets a modal dialog own every key (Escape closes the dialog, not the editor)', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.append(button);
    expect(focusContextOf(dialog, false)).toBe('dialog');
    expect(focusContextOf(button, false)).toBe('dialog');
    const shell = makeShell();
    const e = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(e, 'target', { value: button });
    expect(resolveKeydown(asShell(shell), e)).toBeNull();
  });

  it("treats the command menu's own search box as the menu, not a text field", () => {
    const menu = document.createElement('mui-command-menu');
    const search = document.createElement('input');
    menu.append(search);
    expect(focusContextOf(search, true)).toBe('menu');
    expect(focusContextOf(search, false)).toBe('text');
  });

  it('fires before/after from \\ or B, with or without Shift on the letter', () => {
    const shell = makeShell();
    const press = (init: KeyboardEventInit) =>
      resolveKeydown(asShell(shell), new KeyboardEvent('keydown', init))?.intent.kind ?? null;
    expect(press({ key: '\\' })).toBe('compare.press');
    expect(press({ key: 'b' })).toBe('compare.press');
    expect(press({ key: 'B', shiftKey: true })).toBe('compare.press');
    // Shift+\ is `|` — a different key, and no command's.
    expect(press({ key: '|', shiftKey: true })).toBeNull();
  });
});

describe('executeIntent', () => {
  it('refuses an asset-bound intent resolved for a different asset', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    const bound = resolveKeydown(asShell(shell), new KeyboardEvent('keydown', { key: '5' }))!;
    expect(bound.assetId).toBe('a.dng');
    shell.focused.set('b.dng');
    expect(executeIntent(asShell(shell), router, bound)).toBe(false);
    expect(shell.state.setRating).not.toHaveBeenCalled();
    // Back and the menu toggle are not asset-bound.
    expect(
      executeIntent(asShell(shell), router, { intent: { kind: 'nav.back' }, assetId: 'a.dng' }),
    ).toBe(true);
  });

  it('refuses navigation while a wheel burst is still in flight', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    // A plain (not commit-on-release) tool never calls beginGesture, so the
    // burst's open undo transaction is the only thing standing between the
    // user and an asset switch that would reset the ring and drop it.
    shell.wheelNudge.burstOpen = true;
    shell.wheelNudge.lastAt = performance.now();
    expect(
      executeIntent(asShell(shell), router, { intent: { kind: 'nav.next' }, assetId: 'a.dng' }),
    ).toBe(false);
    shell.wheelNudge.burstOpen = false;
    expect(
      executeIntent(asShell(shell), router, { intent: { kind: 'nav.next' }, assetId: 'a.dng' }),
    ).toBe(true);
  });

  it('refuses navigation while a gesture is in flight, then allows it', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    shell.editorState.gestureActive = () => true;
    expect(
      executeIntent(asShell(shell), router, { intent: { kind: 'nav.next' }, assetId: 'a.dng' }),
    ).toBe(false);
    shell.editorState.gestureActive = () => false;
    expect(
      executeIntent(asShell(shell), router, { intent: { kind: 'nav.next' }, assetId: 'a.dng' }),
    ).toBe(true);
    expect(shell.navigateToAsset).toHaveBeenCalledWith('b.dng');
  });

  it('toggles a flag off when the same flag is already set', () => {
    const shell = makeShell();
    executeIntent(asShell(shell), newCommandRouterState(), {
      intent: { kind: 'asset.flag', flag: 'pick' },
      assetId: 'a.dng',
    });
    expect(shell.state.setFlag).toHaveBeenCalledWith('a.dng', 'unflagged');
  });

  it('press/release: a short press toggles the latched split, a long hold only peeks', () => {
    vi.useFakeTimers();
    try {
      const shell = makeShell();
      const router = newCommandRouterState();
      const press = { intent: { kind: 'compare.press' } as const, assetId: 'a.dng' };
      const release = { intent: { kind: 'compare.release' } as const, assetId: 'a.dng' };
      expect(executeIntent(asShell(shell), router, press)).toBe(true);
      // A second press while held is ignored (auto-repeat, second pointer).
      expect(executeIntent(asShell(shell), router, press)).toBe(false);
      expect(shell.canvasSvc.beginPeekBefore).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(COMPARE_HOLD_MS - 50);
      executeIntent(asShell(shell), router, release);
      expect(shell.canvasSvc.endPeekBefore).toHaveBeenCalledTimes(1);
      expect(shell.canvasSvc.toggleBeforeAfter).toHaveBeenCalledTimes(1);

      executeIntent(asShell(shell), router, press);
      vi.advanceTimersByTime(COMPARE_HOLD_MS + 50);
      executeIntent(asShell(shell), router, release);
      expect(shell.canvasSvc.endPeekBefore).toHaveBeenCalledTimes(2);
      expect(shell.canvasSvc.toggleBeforeAfter).toHaveBeenCalledTimes(1);
      // A release with nothing pressed is a no-op.
      expect(executeIntent(asShell(shell), router, release)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('activates before/after from a synthesized click (keyboard / AT), not a pointer one', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    // Enter, Space and an AT "press" action synthesize a click with detail 0
    // and no pointerdown/up pair — without this the control is mouse-only.
    compareActivate(asShell(shell), router, new MouseEvent('click', { detail: 0 }));
    expect(shell.canvasSvc.toggleBeforeAfter).toHaveBeenCalledTimes(1);
    // A real pointer click already ran the press/release pair; ignore it.
    compareActivate(asShell(shell), router, new MouseEvent('click', { detail: 1 }));
    expect(shell.canvasSvc.toggleBeforeAfter).toHaveBeenCalledTimes(1);
  });

  it('a release on another asset ends the peek without latching', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    executeIntent(asShell(shell), router, { intent: { kind: 'compare.press' }, assetId: 'a.dng' });
    shell.focused.set('b.dng');
    expect(
      executeIntent(asShell(shell), router, {
        intent: { kind: 'compare.release' },
        assetId: 'b.dng',
      }),
    ).toBe(false);
    expect(shell.canvasSvc.endPeekBefore).toHaveBeenCalledTimes(1);
    expect(shell.canvasSvc.toggleBeforeAfter).not.toHaveBeenCalled();
    expect(router.comparePressedAt).toBeNull();
  });

  it('cancelCompare ends a peek without toggling', () => {
    const shell = makeShell();
    const router = newCommandRouterState();
    executeIntent(asShell(shell), router, { intent: { kind: 'compare.press' }, assetId: 'a.dng' });
    cancelCompare(asShell(shell), router);
    expect(shell.canvasSvc.endPeekBefore).toHaveBeenCalledTimes(1);
    expect(shell.canvasSvc.toggleBeforeAfter).not.toHaveBeenCalled();
    expect(router.comparePressedAt).toBeNull();
  });

  it('refuses a value nudge while the armed tool takes no value edits', () => {
    const shell = makeShell();
    shell.editorState.armedToolAcceptsValueEdits = () => false;
    expect(
      executeIntent(asShell(shell), newCommandRouterState(), {
        intent: { kind: 'value.nudge', direction: 1 },
        assetId: 'a.dng',
      }),
    ).toBe(false);
    expect(shell.editorState.commit).not.toHaveBeenCalled();
  });
});

describe('command table', () => {
  it('has unique ids and a distinct chord per command (no two commands claim one key)', () => {
    const ids = EDITOR_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const probes = [
      'z',
      's',
      'c',
      '\\',
      'b',
      'f',
      '0',
      '1',
      '=',
      '-',
      ']',
      '[',
      'r',
      'p',
      'x',
      'u',
      'h',
      'k',
      '?',
      'ArrowLeft',
      'ArrowRight',
      'Escape',
    ];
    for (const key of probes) {
      for (const meta of [false, true]) {
        for (const shift of [false, true]) {
          for (const alt of [false, true]) {
            const e = new KeyboardEvent('keydown', {
              key,
              metaKey: meta,
              shiftKey: shift,
              altKey: alt,
            });
            const claimants = EDITOR_COMMANDS.filter((c) =>
              c.chords.some((ch) => chordMatches(ch, e)),
            );
            expect(
              claimants.length,
              `${key} meta=${meta} shift=${shift} alt=${alt}`,
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('describes chords for people and for aria-keyshortcuts', () => {
    expect(describeChord({ key: 'z', meta: true, shift: true })).toBe('⌘⇧Z');
    expect(describeChord({ key: 'ArrowRight', shift: true })).toBe('⇧→');
    expect(ariaKeyshortcuts('history.undo')).toBe('Meta+Z Control+Z');
    expect(ariaKeyshortcuts('chrome.inspector')).toBe('Meta+Alt+D Control+Alt+D');
    // Every key a command accepts is announced, not only the first one.
    expect(ariaKeyshortcuts('compare.press')).toBe('\\ B');
    expect(ariaKeyshortcuts('zoom.in')).toBe('Meta+= Control+= Meta++ Control++');
    expect(ariaKeyshortcuts('nope')).toBeNull();
  });
});
