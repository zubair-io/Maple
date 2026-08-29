// MuiVideoPlayer — the Maple UI design-system Video Player molecule
// (unified-component-catalog.md §2.7; Built from: Button, Progress,
// Timestamp). Transport controls around a native `<video>` element: a
// play/pause toggle, a click-to-seek `mui-progress` scrubber, and mm:ss time
// readouts (styled like `mui-timestamp`, but not the component itself —
// Timestamp formats calendar dates, not elapsed/duration, so this owns a
// small local `formatDuration`). No play/pause glyph exists in the shared
// icon registry, so the transport button projects a plain Unicode
// triangle/bars label instead of an icon.

import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MediaTransportBase } from '../internal/media-transport';

@Component({
  selector: 'mui-video-player',
  standalone: true,
  imports: [MuiButtonComponent, MuiProgressComponent],
  templateUrl: './mui-video-player.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVideoPlayerComponent extends MediaTransportBase {
  readonly src = input.required<string>();
  readonly poster = input<string | null>(null);

  readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  protected mediaEl(): HTMLMediaElement | undefined {
    return this.video()?.nativeElement;
  }
}
