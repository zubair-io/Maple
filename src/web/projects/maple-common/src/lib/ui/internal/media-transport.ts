// Shared transport logic for the Maple UI media molecules (mui-audio-player,
// mui-video-player — unified-component-catalog.md §2.7): both are "native
// media element + play/pause + click-to-seek scrubber + mm:ss readout", one
// over `<audio>`, one over `<video>`. Not part of the public API surface
// (see ../public-api.ts).

import type { WritableSignal } from '@angular/core';

/** Formats elapsed/duration seconds as `m:ss` (never `h:mm:ss` — Maple's
 * transport clips are all sub-hour). Non-finite or negative input (not yet
 * loaded) reads as `0:00`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Scrubber fill percentage for the current playback position. */
export function computeProgressPercent(currentTime: number, duration: number): number {
  return duration > 0 ? (currentTime / duration) * 100 : 0;
}

/** Plays if paused, pauses if playing — the shared transport-button
 * behavior. No-op when the element isn't mounted yet. */
export function toggleMediaPlayback(el: HTMLMediaElement | undefined): void {
  if (!el) return;
  if (el.paused) el.play();
  else el.pause();
}

/** `loadedmetadata` handler: publishes the element's now-known duration. */
export function handleLoadedMetadata(
  el: HTMLMediaElement | undefined,
  duration: WritableSignal<number>,
): void {
  if (el) duration.set(el.duration || 0);
}

/** `timeupdate` handler: mirrors the element's playback position. */
export function handleTimeUpdate(
  el: HTMLMediaElement | undefined,
  currentTime: WritableSignal<number>,
): void {
  if (el) currentTime.set(el.currentTime);
}

/** Converts a click on the scrubber track into a target playback time,
 * clamped to the track bounds. `null` when there's no duration to seek
 * within yet (e.g. metadata hasn't loaded). */
export function computeSeekTime(event: MouseEvent, duration: number): number | null {
  if (duration <= 0) return null;
  const track = event.currentTarget as HTMLElement;
  const rect = track.getBoundingClientRect();
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  return clamped * duration;
}
