import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import {
  computeProgressPercent,
  computeSeekTime,
  formatDuration,
  handleLoadedMetadata,
  handleTimeUpdate,
  toggleMediaPlayback,
} from './media-transport';

describe('formatDuration', () => {
  it('formats seconds as m:ss, zero-padded', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(90)).toBe('1:30');
  });

  it('falls back to 0:00 for NaN/negative input', () => {
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('computeProgressPercent', () => {
  it('scales currentTime/duration to a 0-100 percentage', () => {
    expect(computeProgressPercent(30, 120)).toBe(25);
    expect(computeProgressPercent(0, 120)).toBe(0);
  });

  it('returns 0 when duration is not yet known', () => {
    expect(computeProgressPercent(5, 0)).toBe(0);
  });
});

describe('toggleMediaPlayback', () => {
  it('plays a paused element', () => {
    const el = { paused: true, play: vi.fn(), pause: vi.fn() } as unknown as HTMLMediaElement;
    toggleMediaPlayback(el);
    expect(el.play).toHaveBeenCalled();
    expect(el.pause).not.toHaveBeenCalled();
  });

  it('pauses a playing element', () => {
    const el = { paused: false, play: vi.fn(), pause: vi.fn() } as unknown as HTMLMediaElement;
    toggleMediaPlayback(el);
    expect(el.pause).toHaveBeenCalled();
    expect(el.play).not.toHaveBeenCalled();
  });

  it('is a no-op when the element is not mounted yet', () => {
    expect(() => toggleMediaPlayback(undefined)).not.toThrow();
  });
});

describe('handleLoadedMetadata', () => {
  it('publishes the element duration, defaulting a NaN duration to 0', () => {
    const duration = signal(0);
    handleLoadedMetadata({ duration: 42 } as HTMLMediaElement, duration);
    expect(duration()).toBe(42);

    handleLoadedMetadata({ duration: Number.NaN } as HTMLMediaElement, duration);
    expect(duration()).toBe(0);
  });

  it('is a no-op when the element is not mounted yet', () => {
    const duration = signal(7);
    handleLoadedMetadata(undefined, duration);
    expect(duration()).toBe(7);
  });
});

describe('handleTimeUpdate', () => {
  it('mirrors the element playback position', () => {
    const currentTime = signal(0);
    handleTimeUpdate({ currentTime: 12 } as HTMLMediaElement, currentTime);
    expect(currentTime()).toBe(12);
  });

  it('is a no-op when the element is not mounted yet', () => {
    const currentTime = signal(3);
    handleTimeUpdate(undefined, currentTime);
    expect(currentTime()).toBe(3);
  });
});

describe('computeSeekTime', () => {
  function trackClick(clientX: number): MouseEvent {
    const track = { getBoundingClientRect: () => ({ left: 0, width: 100 }) } as HTMLElement;
    return { currentTarget: track, clientX } as unknown as MouseEvent;
  }

  it('maps a click position to a clamped seek time', () => {
    expect(computeSeekTime(trackClick(50), 200)).toBe(100);
    expect(computeSeekTime(trackClick(-10), 200)).toBe(0);
    expect(computeSeekTime(trackClick(500), 200)).toBe(200);
  });

  it('returns null when there is no duration to seek within', () => {
    expect(computeSeekTime(trackClick(50), 0)).toBeNull();
  });
});
