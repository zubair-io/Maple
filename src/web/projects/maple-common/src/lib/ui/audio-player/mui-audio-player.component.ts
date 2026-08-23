// MuiAudioPlayer — the Maple UI design-system Audio Player molecule
// (unified-component-catalog.md §2.7; Built from: Button, Progress,
// Timestamp). "Waveform-less audio transport" per the catalog — the same
// play/pause + scrubber + mm:ss shape as MuiVideoPlayer, around a native
// `<audio>` element instead of `<video>` (no poster/frame).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import {
  computeProgressPercent,
  computeSeekTime,
  formatDuration,
  handleLoadedMetadata,
  handleTimeUpdate,
  toggleMediaPlayback,
} from '../internal/media-transport';

@Component({
  selector: 'mui-audio-player',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressComponent],
  templateUrl: './mui-audio-player.component.html',
  styleUrl: './mui-audio-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAudioPlayerComponent {
  readonly src = input.required<string>();

  readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  readonly playing = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);

  readonly formatDuration = formatDuration;

  progressPercent(): number {
    return computeProgressPercent(this.currentTime(), this.duration());
  }

  togglePlay(): void {
    toggleMediaPlayback(this.audio()?.nativeElement);
  }

  onPlay(): void {
    this.playing.set(true);
  }

  onPause(): void {
    this.playing.set(false);
  }

  onEnded(): void {
    this.playing.set(false);
  }

  onLoadedMetadata(): void {
    handleLoadedMetadata(this.audio()?.nativeElement, this.duration);
  }

  onTimeUpdate(): void {
    handleTimeUpdate(this.audio()?.nativeElement, this.currentTime);
  }

  seek(event: MouseEvent): void {
    const el = this.audio()?.nativeElement;
    const next = computeSeekTime(event, this.duration());
    if (!el || next === null) return;
    el.currentTime = next;
    this.currentTime.set(el.currentTime);
  }
}
