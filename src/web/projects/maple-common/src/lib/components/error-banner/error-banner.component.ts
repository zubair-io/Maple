// ErrorBanner — inline error banner with an optional Retry button.
// Used by the BrowseShell when the Self-Hosted API returns 5xx, or when the
// index is empty and the user needs to configure folders in admin.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-error-banner',
  standalone: true,
  templateUrl: './error-banner.component.html',
  styleUrl: './error-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorBannerComponent {
  readonly message = input.required<string>();
  readonly retryLabel = input<string>('Retry');
  readonly showRetry = input<boolean>(true);
  readonly hintHref = input<string | null>(null);
  readonly hintLabel = input<string | null>(null);

  readonly retry = output<void>();

  onRetry(): void {
    this.retry.emit();
  }
}
