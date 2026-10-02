import { describe, expect, it, vi } from 'vitest';
import { setupFixture } from './preview-shell.test-helpers';

function pointer(
  fixture: ReturnType<typeof setupFixture>['fixture'],
  type: string,
  x: number,
  y: number,
  options: PointerEventInit = {},
): void {
  fixture.detectChanges();
  const surface = fixture.nativeElement.querySelector('[data-testid="preview-surface"]');
  surface.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      ...options,
    }),
  );
}

for (const [dx, dy, direction] of [
  [-60, 5, 'next'],
  [70, -5, 'prev'],
  [15, 0, null],
  [50, 100, null],
] as const) {
  it(`photo swipe (${dx}, ${dy}) resolves to ${direction ?? 'no navigation'}`, () => {
    const { fixture } = setupFixture();
    const next = vi.spyOn(fixture.componentInstance, 'goNext');
    const prev = vi.spyOn(fixture.componentInstance, 'goPrev');
    pointer(fixture, 'pointerdown', 200, 100);
    pointer(fixture, 'pointerup', 200 + dx, 100 + dy);
    expect(next).toHaveBeenCalledTimes(direction === 'next' ? 1 : 0);
    expect(prev).toHaveBeenCalledTimes(direction === 'prev' ? 1 : 0);
  });
}

it('cancellation never pages and the next valid gesture still does', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointercancel', 100, 100);
  pointer(fixture, 'pointerup', 100, 100);
  expect(next).not.toHaveBeenCalled();
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointerup', 100, 100);
  expect(next).toHaveBeenCalledTimes(1);
});

it('a secondary finger cancels photo paging instead of replacing its origin', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointerdown', 220, 100, { pointerId: 2, isPrimary: false });
  pointer(fixture, 'pointerup', 100, 100);
  pointer(fixture, 'pointerup', 120, 100, { pointerId: 2, isPrimary: false });
  expect(next).not.toHaveBeenCalled();
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointerup', 100, 100);
  expect(next).toHaveBeenCalledTimes(1);
});

it('foreign pointer releases cannot finish or discard the tracked gesture', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointerup', 100, 100, { pointerId: 2 });
  expect(next).not.toHaveBeenCalled();
  pointer(fixture, 'pointerup', 100, 100);
  expect(next).toHaveBeenCalledTimes(1);
});

it('right-button presses and mixed-button sequences cannot page', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100, { button: 2 });
  pointer(fixture, 'pointerup', 100, 100, { button: 2 });
  pointer(fixture, 'pointerdown', 200, 100);
  pointer(fixture, 'pointerdown', 190, 100, { button: 2 });
  pointer(fixture, 'pointerup', 100, 100);
  expect(next).not.toHaveBeenCalled();
});

it('a document release outside the preview can finish only the tracked gesture', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100);
  document.dispatchEvent(
    new PointerEvent('pointerup', {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    }),
  );
  expect(next).toHaveBeenCalledTimes(1);
});

it('video controls own their pointer interaction without photo paging', () => {
  const { fixture, state } = setupFixture({
    videoAccess: { apiBase: 'https://video.test', bearer: () => 'fixture-access' },
  });
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  state.focusedAsset.set({
    ...state.focusedAsset()!,
    id: 'library:clip.mp4',
    filename: 'clip.mp4',
    isVideo: true,
  });
  fixture.detectChanges();
  const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
  expect(video.hasAttribute('controls')).toBe(true);
  video.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 200,
      clientY: 100,
    }),
  );
  video.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    }),
  );
  expect(next).not.toHaveBeenCalled();
});

it('destroying the preview clears an outstanding pointer sequence', () => {
  const { fixture } = setupFixture();
  const next = vi.spyOn(fixture.componentInstance, 'goNext');
  pointer(fixture, 'pointerdown', 200, 100);
  fixture.componentInstance.ngOnDestroy();
  fixture.componentInstance.onImagePointerUp(
    new PointerEvent('pointerup', {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    }),
  );
  expect(next).not.toHaveBeenCalled();
});
