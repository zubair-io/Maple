// editor-shell-scrub.spec.ts — which presses start the canvas scrub gesture.
//
// A press on a descendant that owns its pointer stream (the eyedropper pick
// overlay, `[data-owns-pointer]`) must not start a scrub: the scrub commits an
// edit and captures the pointer, which retargets the click the overlay waits
// for and strands the pick.

import { describe, expect, it, vi } from 'vitest';

import { newScrubGestureState, onCanvasPointerDown, cleanupScrub } from './editor-shell-scrub';
import type { EditorShellComponent } from './editor-shell.component';

function fakeShell() {
  const wrap = document.createElement('div');
  wrap.setPointerCapture = vi.fn();
  const editorState = {
    armedToolAcceptsValueEdits: () => true,
    armedInternalValue: () => 0,
    commit: vi.fn(),
    beginGesture: vi.fn(),
  };
  const shell = {
    canvasSvc: { pixelScale: () => 0 },
    canvasWrapRef: { nativeElement: wrap },
    editorState,
    scrubbing: { set: vi.fn() },
    chromeState: { set: vi.fn() },
    showHud: vi.fn(),
  };
  return { shell: shell as unknown as EditorShellComponent, wrap, editorState };
}

function press(target: Element): PointerEvent {
  const event = new MouseEvent('pointerdown', { bubbles: true, button: 0 }) as PointerEvent;
  Object.defineProperty(event, 'target', { value: target });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

describe('canvas scrub start', () => {
  const scrub = newScrubGestureState();

  it('starts for a press on the plain canvas layer', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, press(wrap));
    expect(editorState.commit).toHaveBeenCalledOnce();
    expect(editorState.beginGesture).toHaveBeenCalledOnce();
    expect(wrap.setPointerCapture).toHaveBeenCalledOnce();
    cleanupScrub(s, scrub);
  });

  it('does not start for a press on a descendant that owns its pointer', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-owns-pointer', '');
    wrap.append(overlay);
    onCanvasPointerDown(s, scrub, press(overlay));
    expect(editorState.commit).not.toHaveBeenCalled();
    expect(editorState.beginGesture).not.toHaveBeenCalled();
    expect(wrap.setPointerCapture).not.toHaveBeenCalled();
  });
});
