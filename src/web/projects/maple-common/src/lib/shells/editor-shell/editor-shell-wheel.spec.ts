// editor-shell-wheel.spec.ts — the scroll-wheel slider nudge (#2450):
// detent accumulation, ⇧/⌥ units, burst-scoped undo, commit-on-release
// flushing, and the hand-off rules with the canvas's own wheel handling.

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { EditorShellComponent } from './editor-shell.component';
import {
  BURST_MS,
  DETENT_PX,
  FLUSH_MS,
  cleanupWheel,
  detentsFor,
  newWheelNudgeState,
  onCanvasWheel,
  unitFor,
  wheelBurstActive,
} from './editor-shell-wheel';

function makeShell(
  opts: { pixelScale?: number; commitsOnRelease?: boolean; accepts?: boolean } = {},
) {
  let value = 0;
  const shell = {
    canvasSvc: { pixelScale: () => opts.pixelScale ?? 0 },
    editorState: {
      armedTool: signal('exposure'),
      armedSubParamId: signal<string | null>(null),
      imageId: signal<string | null>('a.dng'),
      armedToolAcceptsValueEdits: () => opts.accepts ?? true,
      armedCommitsOnRelease: () => opts.commitsOnRelease ?? false,
      armedInternalValue: () => value,
      setArmedInternalValue: vi.fn((v: number) => (value = v)),
      commit: vi.fn(),
      beginGesture: vi.fn(),
      endGesture: vi.fn(),
    },
    showHud: vi.fn(),
    scheduleHudFade: vi.fn(),
  };
  return { shell: shell as unknown as EditorShellComponent, mocks: shell, value: () => value };
}

function wheel(deltaY: number, init: Partial<WheelEventInit> = {}): WheelEvent {
  return new WheelEvent('wheel', { deltaY, deltaMode: 0, cancelable: true, ...init });
}

describe('detentsFor', () => {
  it('turns line-mode ticks into one detent each and accumulates pixel deltas', () => {
    const state = newWheelNudgeState();
    expect(detentsFor(state, wheel(-3, { deltaMode: 1 }))).toBe(1);
    expect(detentsFor(state, wheel(3, { deltaMode: 1 }))).toBe(-1);
    expect(detentsFor(state, wheel(-DETENT_PX / 2))).toBe(0);
    expect(detentsFor(state, wheel(-DETENT_PX / 2))).toBe(1);
    expect(detentsFor(state, wheel(DETENT_PX * 2.5))).toBe(-2);
    expect(detentsFor(state, wheel(0))).toBe(0);
  });

  it('scales the unit with ⇧ and ⌥', () => {
    expect(unitFor({ shiftKey: false, altKey: false })).toBe(1);
    expect(unitFor({ shiftKey: true, altKey: false })).toBe(10);
    expect(unitFor({ shiftKey: false, altKey: true })).toBe(0.1);
  });
});

describe('onCanvasWheel', () => {
  it('leaves zoom chords, consumed events, zoomed views and value-less tools alone', () => {
    const { shell, mocks } = makeShell();
    const state = newWheelNudgeState();
    onCanvasWheel(shell, state, wheel(-40, { metaKey: true }));
    onCanvasWheel(shell, state, wheel(-40, { ctrlKey: true }));
    const consumed = wheel(-40);
    consumed.preventDefault();
    onCanvasWheel(shell, state, consumed);
    expect(mocks.editorState.setArmedInternalValue).not.toHaveBeenCalled();

    const zoomed = makeShell({ pixelScale: 2 });
    onCanvasWheel(zoomed.shell, state, wheel(-40));
    expect(zoomed.mocks.editorState.setArmedInternalValue).not.toHaveBeenCalled();

    const inert = makeShell({ accepts: false });
    const e = wheel(-40);
    onCanvasWheel(inert.shell, state, e);
    expect(inert.mocks.editorState.setArmedInternalValue).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('nudges the armed tool per detent, clamped, and shows the HUD', () => {
    const { shell, mocks, value } = makeShell();
    const state = newWheelNudgeState();
    const e = wheel(-DETENT_PX * 3);
    onCanvasWheel(shell, state, e, 1000);
    expect(e.defaultPrevented).toBe(true);
    expect(value()).toBe(3);
    onCanvasWheel(shell, state, wheel(-DETENT_PX * 200, { shiftKey: true }), 1100);
    expect(value()).toBe(100);
    expect(mocks.showHud).toHaveBeenCalled();
    expect(mocks.scheduleHudFade).toHaveBeenCalled();
  });

  it('shares one undo entry per burst and starts a new one after a pause or a target change', () => {
    const { shell, mocks } = makeShell();
    const state = newWheelNudgeState();
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000);
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + BURST_MS - 1);
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(1);
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + BURST_MS - 1 + BURST_MS + 1);
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(2);
    mocks.editorState.armedTool.set('contrast');
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + BURST_MS * 2 + 10);
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(3);
    mocks.editorState.armedSubParamId.set('deep');
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + BURST_MS * 2 + 20);
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(4);
    mocks.editorState.imageId.set('b.dng');
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + BURST_MS * 2 + 30);
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(5);
  });

  it('drops the pixel remainder at a burst boundary so a new burst starts from zero', () => {
    const { shell, mocks, value } = makeShell();
    const state = newWheelNudgeState();
    // Nine tenths of a detent — not enough to move anything.
    onCanvasWheel(shell, state, wheel(-DETENT_PX * 0.9), 1000);
    expect(value()).toBe(0);
    // A different tool is a new burst: the 0.9 belonged to the old one, so
    // half a detent against the new target must still not fire.
    mocks.editorState.armedTool.set('contrast');
    onCanvasWheel(shell, state, wheel(-DETENT_PX * 0.5), 1010);
    expect(value()).toBe(0);
    onCanvasWheel(shell, state, wheel(-DETENT_PX * 0.5), 1020);
    expect(value()).toBe(1);
  });

  it('keeps accumulating across sub-detent events inside one burst', () => {
    const { shell, mocks, value } = makeShell();
    const state = newWheelNudgeState();
    for (let i = 0; i < 4; i++) onCanvasWheel(shell, state, wheel(-DETENT_PX / 4), 1000 + i * 10);
    expect(value()).toBe(1);
    // Sub-detent events extend the burst rather than each looking like a new
    // one, so the detent they add up to is still its first undo entry.
    expect(mocks.editorState.commit).toHaveBeenCalledTimes(1);
  });

  it('reports the burst as in flight only until it goes idle', () => {
    const { shell } = makeShell();
    const state = newWheelNudgeState();
    expect(wheelBurstActive(state, 1000)).toBe(false);
    onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000);
    expect(wheelBurstActive(state, 1000)).toBe(true);
    expect(wheelBurstActive(state, 1000 + BURST_MS)).toBe(true);
    expect(wheelBurstActive(state, 1000 + BURST_MS + 1)).toBe(false);
  });

  it('opens a new undo entry for a detent that lands after the commit-on-release flush', () => {
    vi.useFakeTimers();
    try {
      const { shell, mocks } = makeShell({ commitsOnRelease: true });
      const state = newWheelNudgeState();
      onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000);
      expect(mocks.editorState.commit).toHaveBeenCalledTimes(1);
      // The flush closes the transaction, so the burst it belonged to is over
      // even though the next detent is still inside BURST_MS.
      vi.advanceTimersByTime(FLUSH_MS + 10);
      expect(mocks.editorState.endGesture).toHaveBeenCalledTimes(1);
      expect(wheelBurstActive(state, 1000 + FLUSH_MS + 10)).toBe(false);
      onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000 + FLUSH_MS + 10);
      expect(mocks.editorState.commit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks commit-on-release fields for the burst and flushes after the idle delay', () => {
    vi.useFakeTimers();
    try {
      const { shell, mocks } = makeShell({ commitsOnRelease: true });
      const state = newWheelNudgeState();
      onCanvasWheel(shell, state, wheel(-DETENT_PX), 1000);
      onCanvasWheel(shell, state, wheel(-DETENT_PX), 1050);
      expect(mocks.editorState.beginGesture).toHaveBeenCalledTimes(2);
      expect(mocks.editorState.endGesture).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FLUSH_MS - 10);
      expect(mocks.editorState.endGesture).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(mocks.editorState.endGesture).toHaveBeenCalledTimes(1);

      onCanvasWheel(shell, state, wheel(-DETENT_PX), 2000);
      cleanupWheel(shell, state);
      expect(mocks.editorState.endGesture).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(FLUSH_MS * 2);
      expect(mocks.editorState.endGesture).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
