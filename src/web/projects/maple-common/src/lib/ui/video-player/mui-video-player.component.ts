// MuiVideoPlayer — the Maple UI design-system Video Player molecule
// (unified-component-catalog.md §2.7; Built from: Button, Progress,
// Timestamp). Transport controls around a native `<video>` element: a
// play/pause toggle, a click-to-seek `mui-progress` scrubber, and mm:ss time
// readouts (styled like `mui-timestamp`, but not the component itself —
// Timestamp formats calendar dates, not elapsed/duration, so this owns a
// small local `formatDuration`). No play/pause glyph exists in the shared
// icon registry, so the transport button projects a plain Unicode
// triangle/bars label instead of an icon.

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
  selector: 'mui-video-player',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressComponent],
  templateUrl: './mui-video-player.component.html',
  styleUrl: './mui-video-player.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVideoPlayerComponent {
  readonly src = input.required<string>();
  readonly poster = input<string | null>(null);

  readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly playing = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);

  readonly formatDuration = formatDuration;

  progressPercent(): number {
    return computeProgressPercent(this.currentTime(), this.duration());
  }

  togglePlay(): void {
    toggleMediaPlayback(this.video()?.nativeElement);
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
    handleLoadedMetadata(this.video()?.nativeElement, this.duration);
  }

  onTimeUpdate(): void {
    handleTimeUpdate(this.video()?.nativeElement, this.currentTime);
  }

  seek(event: MouseEvent): void {
    const el = this.video()?.nativeElement;
    const next = computeSeekTime(event, this.duration());
    if (!el || next === null) return;
    el.currentTime = next;
    this.currentTime.set(el.currentTime);
  }
}
