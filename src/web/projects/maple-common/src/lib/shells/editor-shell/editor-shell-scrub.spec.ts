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
  Object.defineProperty(wrap, 'clientWidth', { value: 1000 });
  wrap.setPointerCapture = vi.fn();
  let internal = 0;
  const startModel = { exposure: 0, wbMode: 'asShot' };
  const library = { updateAdjustment: vi.fn() };
  const editorState = {
    library,
    imageId: () => 'a',
    currentAdjustment: () => startModel,
    cancelEdit: vi.fn(),
    armedToolAcceptsValueEdits: () => true,
    armedInternalValue: () => internal,
    setArmedInternalValue: vi.fn((v: number) => (internal = v)),
    commit: vi.fn(),
    beginGesture: vi.fn(),
    endGesture: vi.fn(),
    cancelGesture: vi.fn(),
    endEdit: vi.fn(),
  };
  const shell = {
    canvasSvc: { pointerEditsAtZoom: () => true },
    canvasWrapRef: { nativeElement: wrap },
    editorState,
    scrubbing: { set: vi.fn() },
    chromeState: { set: vi.fn() },
    hudVisible: { set: vi.fn() },
    showHud: vi.fn(),
    scheduleHudFade: vi.fn(),
    restartRecedeTimer: vi.fn(),
  };
  return {
    shell: shell as unknown as EditorShellComponent,
    wrap,
    editorState,
    library,
    startModel,
    internal: () => internal,
  };
}

function pointer(
  type: string,
  target: Element,
  init: { pointerId?: number; clientX?: number; isPrimary?: boolean } = {},
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX ?? 0,
  }) as PointerEvent;
  Object.defineProperty(event, 'target', { value: target });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'isPrimary', { value: init.isPrimary ?? true });
  return event;
}

function press(target: Element): PointerEvent {
  return pointer('pointerdown', target);
}

describe('canvas scrub start', () => {
  const scrub = newScrubGestureState();

  it('starts for a press on the plain canvas layer', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, press(wrap));
    expect(editorState.commit).toHaveBeenCalledOnce();
    expect(editorState.beginGesture).toHaveBeenCalledOnce();
    cleanupScrub(s, scrub);
  });

  // #5745: the image canvas inside this layer captures every pointer for its
  // pinch; a capture here would retarget all later moves and releases away
  // from it, so a pinch at fit scrubbed instead and its pointers never ended.
  it('leaves the pointer captured by the canvas inside it', () => {
    const { shell: s, wrap } = fakeShell();
    onCanvasPointerDown(s, scrub, press(wrap));
    expect(wrap.setPointerCapture).not.toHaveBeenCalled();
    cleanupScrub(s, scrub);
  });

  it('a second pointer turns the scrub into a pinch: the model goes back and nothing leaks', () => {
    const { shell: s, wrap, editorState, library, startModel, internal } = fakeShell();
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 1, clientX: 500 }));
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 1, clientX: 540 }));
    expect(internal()).toBeCloseTo(2, 9);

    onCanvasPointerDown(
      s,
      scrub,
      pointer('pointerdown', wrap, { pointerId: 2, clientX: 700, isPrimary: false }),
    );
    expect(library.updateAdjustment).toHaveBeenCalledExactlyOnceWith('a', startModel);
    expect(editorState.cancelGesture).toHaveBeenCalledOnce();
    expect(editorState.cancelEdit).toHaveBeenCalledOnce();
    expect(editorState.endEdit).not.toHaveBeenCalled();

    editorState.setArmedInternalValue.mockClear();
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 1, clientX: 900 }));
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 2, clientX: 900 }));
    expect(editorState.setArmedInternalValue).not.toHaveBeenCalled();
  });

  it('two presses then two releases leave no window listener editing the value', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 1, clientX: 500 }));
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 3, clientX: 500 }));
    window.dispatchEvent(pointer('pointerup', wrap, { pointerId: 1, clientX: 500 }));
    window.dispatchEvent(pointer('pointerup', wrap, { pointerId: 3, clientX: 500 }));
    editorState.setArmedInternalValue.mockClear();
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 1, clientX: 900 }));
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 3, clientX: 900 }));
    expect(editorState.setArmedInternalValue).not.toHaveBeenCalled();
  });

  it('a primary press while a scrub never saw its release abandons it and starts afresh', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 1, clientX: 500 }));
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 1, clientX: 100 }));
    expect(editorState.cancelGesture).toHaveBeenCalledOnce();
    expect(editorState.commit).toHaveBeenCalledTimes(2);
    editorState.setArmedInternalValue.mockClear();
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 1, clientX: 140 }));
    expect(editorState.setArmedInternalValue).toHaveBeenCalledExactlyOnceWith(2);
    cleanupScrub(s, scrub);
  });

  it('does not start for a press on a control inside the canvas', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    const retry = document.createElement('button');
    wrap.append(retry);
    onCanvasPointerDown(s, scrub, press(retry));
    expect(editorState.commit).not.toHaveBeenCalled();
  });

  it('only the scrubbing pointer moves the value', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { pointerId: 1, clientX: 500 }));
    window.dispatchEvent(pointer('pointermove', wrap, { pointerId: 7, clientX: 900 }));
    expect(editorState.setArmedInternalValue).not.toHaveBeenCalled();
    cleanupScrub(s, scrub);
  });

  it('does not start for a non-primary pointer or a press a canvas layer already took', () => {
    const { shell: s, wrap, editorState } = fakeShell();
    onCanvasPointerDown(s, scrub, pointer('pointerdown', wrap, { isPrimary: false }));
    const taken = press(wrap);
    taken.preventDefault();
    onCanvasPointerDown(s, scrub, taken);
    expect(editorState.commit).not.toHaveBeenCalled();
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
