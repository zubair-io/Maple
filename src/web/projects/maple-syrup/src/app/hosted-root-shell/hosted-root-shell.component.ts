import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {
  GpuFallbackNoticeComponent,
  MuiStatusTextComponent,
  SidecarSaveStateService,
  UpdateToastComponent,
} from '@maple-common';

/** Hosted root composition. Server discovery/LAN handoff is deliberately not
 * imported, which keeps its auth and companion-server graph out of this app. */
@Component({
  selector: 'maple-syrup-root-shell',
  standalone: true,
  imports: [RouterOutlet, UpdateToastComponent, GpuFallbackNoticeComponent, MuiStatusTextComponent],
  templateUrl: './hosted-root-shell.component.html',
  styleUrl: './hosted-root-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedRootShellComponent {
  // Replaces the deleted `maple-save-status` wrapper (MW2, #3029) — see
  // `RootShellComponent`'s identical field for why this lives on the
  // service now instead of a per-app wrapper component.
  protected readonly saveState = inject(SidecarSaveStateService);
}
