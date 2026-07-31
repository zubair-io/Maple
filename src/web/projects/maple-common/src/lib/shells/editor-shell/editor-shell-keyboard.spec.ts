// editor-shell-keyboard.spec.ts — canvas-first editor (A) keyboard parity
// with the S5 editor (epic #1807 slice 5).
//
// `handleEditorKeydown` is a pure dispatch function operating on the shell
// via its public surface (see `editor-shell-keyboard.ts`), so it's tested
// here against a lightweight mock shell object — no TestBed / template
// render needed (mirrors how cheaply the S5 editor's own `onKey` handler
// could be tested, had it been extracted). The full-render DOM wiring for
// the undo button / Info sheet / tab-bar visibility is covered by
// `editor-shell-parity.spec.ts`.
//
// Ported from `editor.component.ts` (B)'s `onKey` handler:
//   - ⌘S / Ctrl+S            — flush pending XMP writes
//   - ⌘Z / Ctrl+Z            — undo
//   - ⌘⇧Z / Ctrl+Shift+Z     — redo
//   - [ / ]                 — cycle armed tool; Shift cycles the group
//
// NOT ported: B's bare `0` (reset armed tool) collides with A's pre-existing
// bare `0` (clear rating, real and working) — see the file header comment
// in editor-shell-keyboard.ts.

import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolGroup, ToolId } from '../../editor/tool-model';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { handleEditorKeydown } from './editor-shell-keyboard';
import type { EditorShellComponent } from './editor-shell.component';

// `handleEditorKeydown` reads `e.target` unconditionally (real keydown events
// always carry one — the shell binds via `@HostListener('document:keydown')`).
// A bare `new KeyboardEvent(...)` that's never dispatched has `target ===
// null`, so every call here defaults it to `document.body` (a plain element,
// not a text field) unless the test explicitly wants a text-field target.
function makeKeyEvent(
  key: string,
  opts: {
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    target?: EventTarget;
  } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    cancelable: true,
  });
  Object.defineProperty(ev, 'target', { value: opts.target ?? document.body, configurable: true });
  return ev;
}

describe('handleEditorKeydown (epic #1807 slice 5 parity)', () => {
  let shell: {
    state: {
      focusedAssetId: () => string | null;
      setRating: ReturnType<typeof vi.fn>;
      setFlag: ReturnType<typeof vi.fn>;
      peekPrev: ReturnType<typeof vi.fn>;
      peekNext: ReturnType<typeof vi.fn>;
      toggleSidebar: ReturnType<typeof vi.fn>;
      toggleInspector: ReturnType<typeof vi.fn>;
      flushPendingXmpWrites: ReturnType<typeof vi.fn>;
    };
    editorState: {
      armedGroup: ReturnType<typeof signal<ToolGroup>>;
      armedTool: ReturnType<typeof signal<ToolId>>;
      armedToolAcceptsValueEdits: () => boolean;
      armedInternalValue: () => number;
      currentAdjustment: () => Partial<AdjustmentModel> | null;
      commit: ReturnType<typeof vi.fn>;
      setArmedInternalValue: ReturnType<typeof vi.fn>;
      undo: ReturnType<typeof vi.fn>;
      redo: ReturnType<typeof vi.fn>;
    };
    canvasSvc: {
      toggleBeforeAfter: ReturnType<typeof vi.fn>;
      zoomToFit: ReturnType<typeof vi.fn>;
      zoomTo100: ReturnType<typeof vi.fn>;
    };
    controlCard?: { resetGroup: ReturnType<typeof vi.fn> };
    goBack: ReturnType<typeof vi.fn>;
    navigateToAsset: ReturnType<typeof vi.fn>;
    onGroupChange: ReturnType<typeof vi.fn>;
    onToolChange: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    shell = {
      state: {
        focusedAssetId: () => 'a.dng',
        setRating: vi.fn(),
        setFlag: vi.fn(),
        peekPrev: vi.fn(),
        peekNext: vi.fn(),
        toggleSidebar: vi.fn(),
        toggleInspector: vi.fn(),
        flushPendingXmpWrites: vi.fn(() => Promise.resolve()),
      },
      editorState: {
        armedGroup: signal<ToolGroup>('light'),
        armedTool: signal<ToolId>('exposure'),
        armedToolAcceptsValueEdits: () => true,
        armedInternalValue: () => 0,
        currentAdjustment: () => ({ blackWhite: 'Off' }),
        commit: vi.fn(),
        setArmedInternalValue: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
      },
      canvasSvc: {
        toggleBeforeAfter: vi.fn(),
        zoomToFit: vi.fn(),
        zoomTo100: vi.fn(),
      },
      controlCard: { resetGroup: vi.fn() },
      goBack: vi.fn(),
      navigateToAsset: vi.fn(),
      onGroupChange: vi.fn((g: ToolGroup) => shell.editorState.armedGroup.set(g)),
      onToolChange: vi.fn((t: ToolId) => shell.editorState.armedTool.set(t)),
    };
  });

  function dispatch(ev: KeyboardEvent): void {
    handleEditorKeydown(shell as unknown as EditorShellComponent, ev);
  }

  // ── ⌘S / Ctrl+S — flush XMP ──────────────────────────────────────────────

  it('⌘S flushes pending XMP writes', () => {
    const ev = makeKeyEvent('s', { meta: true });
    dispatch(ev);
    expect(shell.state.flushPendingXmpWrites).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Ctrl+S flushes pending XMP writes', () => {
    const ev = makeKeyEvent('s', { ctrl: true });
    dispatch(ev);
    expect(shell.state.flushPendingXmpWrites).toHaveBeenCalledTimes(1);
  });

  it('⌘⌥S (toggle sidebar) is unaffected — does not flush XMP', () => {
    dispatch(makeKeyEvent('s', { meta: true, alt: true }));
    expect(shell.state.flushPendingXmpWrites).not.toHaveBeenCalled();
    expect(shell.state.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  // ── ⌘Z / ⌘⇧Z — undo / redo ───────────────────────────────────────────────

  it('⌘Z undoes', () => {
    dispatch(makeKeyEvent('z', { meta: true }));
    expect(shell.editorState.undo).toHaveBeenCalledTimes(1);
    expect(shell.editorState.redo).not.toHaveBeenCalled();
  });

  it('Ctrl+Z undoes', () => {
    dispatch(makeKeyEvent('z', { ctrl: true }));
    expect(shell.editorState.undo).toHaveBeenCalledTimes(1);
  });

  it('⌘⇧Z redoes', () => {
    dispatch(makeKeyEvent('Z', { meta: true, shift: true }));
    expect(shell.editorState.redo).toHaveBeenCalledTimes(1);
    expect(shell.editorState.undo).not.toHaveBeenCalled();
  });

  it('bare z (no meta) is NOT undo — it is the existing 1:1 zoom shortcut', () => {
    dispatch(makeKeyEvent('z'));
    expect(shell.editorState.undo).not.toHaveBeenCalled();
    expect(shell.canvasSvc.zoomTo100).toHaveBeenCalledTimes(1);
  });

  // ── [ / ] — cycle tool / group ───────────────────────────────────────────

  it(']  arms the next tool within the current group', () => {
    shell.editorState.armedTool.set('exposure'); // light group
    dispatch(makeKeyEvent(']'));
    expect(shell.onToolChange).toHaveBeenCalledTimes(1);
    const nextTool = shell.onToolChange.mock.calls[0][0];
    expect(nextTool).not.toBe('exposure');
  });

  it('[ arms the previous tool within the current group', () => {
    shell.editorState.armedTool.set('exposure');
    dispatch(makeKeyEvent('['));
    expect(shell.onToolChange).toHaveBeenCalledTimes(1);
  });

  it('Shift+] cycles the armed GROUP, not just the tool', () => {
    shell.editorState.armedGroup.set('light');
    dispatch(makeKeyEvent(']', { shift: true }));
    expect(shell.onGroupChange).toHaveBeenCalledWith('color');
    expect(shell.onToolChange).not.toHaveBeenCalled();
  });

  it('Shift+[ cycles the armed group backward', () => {
    shell.editorState.armedGroup.set('light');
    dispatch(makeKeyEvent('[', { shift: true }));
    expect(shell.onGroupChange).toHaveBeenCalledWith('detail');
  });

  it(']  never cycles onto hsl while Black & White is On (#276)', () => {
    shell.editorState.currentAdjustment = () => ({ blackWhite: 'On' });
    shell.editorState.armedTool.set('saturation'); // color group, just before hsl
    dispatch(makeKeyEvent(']'));
    expect(shell.onToolChange).toHaveBeenCalledTimes(1);
    // Next after saturation in the full list would be hsl — with B&W on it
    // must skip straight to bwMix.
    expect(shell.onToolChange.mock.calls[0][0]).toBe('bwMix');
  });

  it(']  cycles onto hsl normally while Black & White is Off', () => {
    shell.editorState.currentAdjustment = () => ({ blackWhite: 'Off' });
    shell.editorState.armedTool.set('saturation');
    dispatch(makeKeyEvent(']'));
    expect(shell.onToolChange.mock.calls[0][0]).toBe('hsl');
  });

  // ── Existing A shortcuts keep working ────────────────────────────────────

  it('Escape still goes back to Browse', () => {
    dispatch(makeKeyEvent('Escape'));
    expect(shell.goBack).toHaveBeenCalledTimes(1);
  });

  it('bare 0 still clears the rating (NOT reset-armed-tool — B behavior skipped, see file header)', () => {
    dispatch(makeKeyEvent('0'));
    expect(shell.state.setRating).toHaveBeenCalledWith('a.dng', 0);
  });

  it('R still resets the armed group via ControlCard', () => {
    dispatch(makeKeyEvent('r'));
    expect(shell.controlCard!.resetGroup).toHaveBeenCalledTimes(1);
  });

  it('bare ArrowRight still navigates to the next asset', () => {
    shell.state.peekNext.mockReturnValue('b.dng');
    dispatch(makeKeyEvent('ArrowRight'));
    expect(shell.navigateToAsset).toHaveBeenCalledWith('b.dng');
  });

  it('Shift+ArrowRight still nudges the armed slider', () => {
    dispatch(makeKeyEvent('ArrowRight', { shift: true }));
    expect(shell.editorState.commit).toHaveBeenCalledTimes(1);
    expect(shell.editorState.setArmedInternalValue).toHaveBeenCalledWith(10);
  });

  // ── Focused-widget guard (#2409) ─────────────────────────────────────────
  // A LivingSlider track is `role="slider"`, tabindex="0" — while it's
  // focused, bare ArrowLeft/ArrowRight must nudge the slider (handled by the
  // slider's own keydown handler), never the filmstrip. LivingSlider itself
  // stops propagation on the keys it consumes (living-slider.component.spec.ts),
  // but the shell's own guard is defense-in-depth for any other role="slider"
  // widget that doesn't. The guard is deliberately NARROW — it skips only the
  // bare value keys a slider semantically consumes; every other shortcut
  // (Escape, undo/redo, save, rating…) keeps working while a slider is
  // focused.

  it('bare ArrowRight does NOT navigate the filmstrip when a role="slider" widget is focused', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    shell.state.peekNext.mockReturnValue('b.dng');
    dispatch(makeKeyEvent('ArrowRight', { target: slider }));
    expect(shell.navigateToAsset).not.toHaveBeenCalled();
  });

  it('bare ArrowLeft does NOT navigate the filmstrip when a role="slider" widget is focused', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    shell.state.peekPrev.mockReturnValue('z.dng');
    dispatch(makeKeyEvent('ArrowLeft', { target: slider }));
    expect(shell.navigateToAsset).not.toHaveBeenCalled();
  });

  it('does NOT navigate when the event target is a descendant of a role="slider" widget', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    const thumb = document.createElement('div');
    slider.appendChild(thumb);
    shell.state.peekNext.mockReturnValue('b.dng');
    dispatch(makeKeyEvent('ArrowRight', { target: thumb }));
    expect(shell.navigateToAsset).not.toHaveBeenCalled();
  });

  it('also guards role="spinbutton" widgets', () => {
    const spin = document.createElement('div');
    spin.setAttribute('role', 'spinbutton');
    shell.state.peekNext.mockReturnValue('b.dng');
    dispatch(makeKeyEvent('ArrowRight', { target: spin }));
    expect(shell.navigateToAsset).not.toHaveBeenCalled();
  });

  it('Escape still goes back to Browse while a role="slider" widget is focused', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    dispatch(makeKeyEvent('Escape', { target: slider }));
    expect(shell.goBack).toHaveBeenCalledTimes(1);
  });

  it('⌘Z still undoes while a role="slider" widget is focused', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    dispatch(makeKeyEvent('z', { meta: true, target: slider }));
    expect(shell.editorState.undo).toHaveBeenCalledTimes(1);
  });

  it('⌘S still flushes pending XMP writes while a role="slider" widget is focused', () => {
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    dispatch(makeKeyEvent('s', { meta: true, target: slider }));
    expect(shell.state.flushPendingXmpWrites).toHaveBeenCalledTimes(1);
  });

  it('a MODIFIED arrow (Shift+ArrowRight) is not swallowed by the slider guard — the armed-slider nudge still runs', () => {
    // Shift+Arrow is not one of the bare value keys a slider consumes, so
    // the guard must let it through to the dispatcher's ±10 nudge path.
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    dispatch(makeKeyEvent('ArrowRight', { shift: true, target: slider }));
    expect(shell.editorState.setArmedInternalValue).toHaveBeenCalledWith(10);
    expect(shell.navigateToAsset).not.toHaveBeenCalled();
  });

  // ── Text-field guard ──────────────────────────────────────────────────────

  it('does nothing when focus is in an input element (e.g. ⌘Z while typing)', () => {
    const input = document.createElement('input');
    dispatch(makeKeyEvent('z', { meta: true, target: input }));
    expect(shell.editorState.undo).not.toHaveBeenCalled();
  });

  it('does nothing when focus is in a textarea', () => {
    const textarea = document.createElement('textarea');
    dispatch(makeKeyEvent('s', { meta: true, target: textarea }));
    expect(shell.state.flushPendingXmpWrites).not.toHaveBeenCalled();
  });

  it('does nothing when focus is in a contentEditable element', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    dispatch(makeKeyEvent(']', { target: div }));
    expect(shell.onToolChange).not.toHaveBeenCalled();
  });
});
