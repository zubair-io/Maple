// Same jsdom-limitations rationale as mui-video-player.component.spec.ts:
// `play()`/`pause()` are stubbed per-instance; lifecycle state is driven by
// dispatching the events this component listens for.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { MuiAudioPlayerComponent } from './mui-audio-player.component';

function render(): { fixture: ComponentFixture<MuiAudioPlayerComponent>; audio: HTMLAudioElement } {
  TestBed.configureTestingModule({ imports: [MuiAudioPlayerComponent] });
  const fixture = TestBed.createComponent(MuiAudioPlayerComponent);
  fixture.componentRef.setInput('src', 'https://example.test/clip.mp3');
  fixture.detectChanges();
  const audio: HTMLAudioElement = fixture.nativeElement.querySelector('audio');
  audio.play = vi.fn().mockResolvedValue(undefined);
  audio.pause = vi.fn();
  return { fixture, audio };
}

describe('MuiAudioPlayerComponent', () => {
  it('shows the play glyph and calls audio.play() on a paused track', () => {
    const { fixture, audio } = render();
    expect(fixture.nativeElement.querySelector('.transport').textContent.trim()).toBe('▶');

    fixture.nativeElement.querySelector('.transport .mui-button').click();
    expect(audio.play).toHaveBeenCalled();
  });

  it('flips to the pause glyph on "play" and back on "pause"', () => {
    const { fixture, audio } = render();
    audio.dispatchEvent(new Event('play'));
    fixture.detectChanges();
    expect(fixture.componentInstance.playing()).toBe(true);
    expect(fixture.nativeElement.querySelector('.transport').textContent.trim()).toBe('❚❚');

    audio.dispatchEvent(new Event('pause'));
    fixture.detectChanges();
    expect(fixture.componentInstance.playing()).toBe(false);
  });

  it('resets to not-playing when the track ends', () => {
    const { fixture, audio } = render();
    audio.dispatchEvent(new Event('play'));
    audio.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(fixture.componentInstance.playing()).toBe(false);
  });

  it('formats the mm:ss readout from loadedmetadata + timeupdate', () => {
    const { fixture, audio } = render();
    Object.defineProperty(audio, 'duration', { value: 42, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();

    Object.defineProperty(audio, 'currentTime', { value: 5, configurable: true });
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.time').textContent.trim()).toBe('0:05 / 0:42');
  });

  it('seeking via the scrubber is a no-op before duration is known', () => {
    const { fixture } = render();
    const scrubber = fixture.nativeElement.querySelector('.scrubber') as HTMLElement;
    scrubber.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 10, right: 200, bottom: 10 }) as DOMRect;

    scrubber.dispatchEvent(new MouseEvent('click', { clientX: 100, bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.currentTime()).toBe(0);
  });
});
