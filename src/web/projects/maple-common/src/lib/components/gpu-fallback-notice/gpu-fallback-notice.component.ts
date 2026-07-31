// GpuFallbackNoticeComponent — surfaces GpuFallbackNoticeService's state
// (#2415). Rendered once at the root (see RootShellComponent) alongside the
// update toast + LAN-switch banner. Pure view: all state lives in the
// service. Styling follows the same utility-class convention as those two —
// no component stylesheet needed. Positioned top-right rather than
// bottom-center so it never stacks with the bottom-anchored banners.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { GpuFallbackNoticeService } from './gpu-fallback-notice.service';

@Component({
  selector: 'maple-gpu-fallback-notice',
  standalone: true,
  templateUrl: './gpu-fallback-notice.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GpuFallbackNoticeComponent {
  private readonly notice = inject(GpuFallbackNoticeService);

  readonly visible = this.notice.visible;
  readonly message = this.notice.message;

  dismiss(): void {
    this.notice.dismiss();
  }
}
