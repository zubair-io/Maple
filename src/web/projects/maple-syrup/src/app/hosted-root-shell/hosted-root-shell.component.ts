import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {
  GpuFallbackNoticeComponent,
  SaveStatusComponent,
  UpdateToastComponent,
} from '@maple-common';

/** Hosted root composition. Server discovery/LAN handoff is deliberately not
 * imported, which keeps its auth and companion-server graph out of this app. */
@Component({
  selector: 'maple-syrup-root-shell',
  standalone: true,
  imports: [RouterOutlet, UpdateToastComponent, GpuFallbackNoticeComponent, SaveStatusComponent],
  templateUrl: './hosted-root-shell.component.html',
  styleUrl: './hosted-root-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedRootShellComponent {}
