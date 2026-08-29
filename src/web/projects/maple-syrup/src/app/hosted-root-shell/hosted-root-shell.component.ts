import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {
  AppUpdateService,
  GpuFallbackNoticeService,
  MuiStatusTextComponent,
  MuiToastContainerComponent,
  SidecarSaveStateService,
} from '@maple-common';

/** Hosted root composition. Server discovery/LAN handoff is deliberately not
 * imported, which keeps its auth and companion-server graph out of this app. */
@Component({
  selector: 'maple-syrup-root-shell',
  standalone: true,
  imports: [RouterOutlet, MuiStatusTextComponent, MuiToastContainerComponent],
  templateUrl: './hosted-root-shell.component.html',
  host: { class: 'block h-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedRootShellComponent {
  // Replaces the deleted `maple-save-status` wrapper (MW2, #3029) — see
  // `RootShellComponent`'s identical field for why this lives on the
  // service now instead of a per-app wrapper component.
  protected readonly saveState = inject(SidecarSaveStateService);
  // Replaces the deleted `UpdateToastComponent` / `GpuFallbackNoticeComponent`
  // wrappers (toast sweep, ticket #3043) — see `RootShellComponent`'s
  // identical fields.
  protected readonly updates = inject(AppUpdateService);
  protected readonly gpuFallback = inject(GpuFallbackNoticeService);
}
