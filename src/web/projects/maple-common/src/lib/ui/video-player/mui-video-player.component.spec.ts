// jsdom implements the `<video>` element's DOM surface but not real
// playback — `play()`/`pause()` are stubbed per-instance and lifecycle
// state (`duration`, `currentTime`) is driven by dispatching the same
// events the real element would fire, exactly like this component listens
// for them.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { MuiVideoPlayerComponent } from './mui-video-player.component';

function render(): { fixture: ComponentFixture<MuiVideoPlayerComponent>; video: HTMLVideoElement } {
  TestBed.configureTestingModule({ imports: [MuiVideoPlayerComponent] });
  const fixture = TestBed.createComponent(MuiVideoPlayerComponent);
  fixture.componentRef.setInput('src', 'https://example.test/clip.mp4');
  fixture.detectChanges();
  const video: HTMLVideoElement = fixture.nativeElement.querySelector('video');
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn();
  return { fixture, video };
}

describe('MuiVideoPlayerComponent', () => {
  it('shows the play glyph and calls video.play() on a paused video', () => {
    const { fixture, video } = render();
    expect(fixture.nativeElement.querySelector('.transport').textContent.trim()).toBe('▶');

    fixture.nativeElement.querySelector('.transport .mui-button').click();
    expect(video.play).toHaveBeenCalled();
  });

  it('flips to the pause glyph once the video fires "play"', () => {
    const { fixture, video } = render();
    video.dispatchEvent(new Event('play'));
    fixture.detectChanges();

    expect(fixture.componentInstance.playing()).toBe(true);
    expect(fixture.nativeElement.querySelector('.transport').textContent.trim()).toBe('❚❚');
  });

  it('flips back to the play glyph on "pause" and on "ended"', () => {
    const { fixture, video } = render();
    video.dispatchEvent(new Event('play'));
    fixture.detectChanges();

    video.dispatchEvent(new Event('pause'));
    fixture.detectChanges();
    expect(fixture.componentInstance.playing()).toBe(false);

    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(fixture.componentInstance.playing()).toBe(false);
  });

  it('reads duration from loadedmetadata and currentTime from timeupdate into the time readout', () => {
    const { fixture, video } = render();
    Object.defineProperty(video, 'duration', { value: 125, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();

    Object.defineProperty(video, 'currentTime', { value: 65, configurable: true });
    video.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.time').textContent.trim()).toBe('1:05 / 2:05');
  });

  it('clicking the scrubber seeks proportionally to the click position', () => {
    const { fixture, video } = render();
    Object.defineProperty(video, 'duration', { value: 100, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();

    const scrubber = fixture.nativeElement.querySelector('.scrubber') as HTMLElement;
    scrubber.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 10, right: 200, bottom: 10 }) as DOMRect;

    let seekedTo: number | null = null;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => seekedTo ?? 0,
      set: (v: number) => {
        seekedTo = v;
      },
    });

    scrubber.dispatchEvent(new MouseEvent('click', { clientX: 100, bubbles: true }));
    fixture.detectChanges();

    expect(seekedTo).toBeCloseTo(50); // halfway across a 100s clip
  });
});
