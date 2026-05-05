// LoadingBanner — thin top-of-panel banner shown while the Self-Hosted API
// is fetching folders / assets. Dumb component; parent controls visibility.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-loading-banner',
  standalone: true,
  templateUrl: './loading-banner.component.html',
  styleUrl: './loading-banner.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingBannerComponent {
  readonly label = input<string>('Loading…');
}
