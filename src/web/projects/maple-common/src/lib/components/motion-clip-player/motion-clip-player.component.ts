import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Plays a short clip that belongs to a still (an Android Motion Photo's
 * embedded video) in place of that still, once, starting on mount. */
@Component({
  selector: 'maple-motion-clip-player',
  standalone: true,
  templateUrl: './motion-clip-player.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MotionClipPlayerComponent {
  readonly src = input.required<string>();
  readonly poster = input<string | undefined>(undefined);
  readonly label = input.required<string>();
  readonly finished = output<void>();
}
