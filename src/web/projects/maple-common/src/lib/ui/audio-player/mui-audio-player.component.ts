// MuiAudioPlayer — the Maple UI design-system Audio Player molecule
// (unified-component-catalog.md §2.7; Built from: Button, Progress,
// Timestamp). "Waveform-less audio transport" per the catalog — the same
// play/pause + scrubber + mm:ss shape as MuiVideoPlayer, around a native
// `<audio>` element instead of `<video>` (no poster/frame).

import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MediaTransportBase } from '../internal/media-transport';

@Component({
  selector: 'mui-audio-player',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressComponent],
  templateUrl: './mui-audio-player.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAudioPlayerComponent extends MediaTransportBase {
  readonly src = input.required<string>();

  readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  protected mediaEl(): HTMLMediaElement | undefined {
    return this.audio()?.nativeElement;
  }
}
