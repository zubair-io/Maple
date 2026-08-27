// root-shell.component.ts — web responsive foundation (#2279).
//
// Top-level shell. Always renders the pane `<router-outlet />` — the phone-
// tab shell fork (S1a, #597) that switched on LayoutService.layout() is
// retired; the pane shells (BrowseShell/EditorShell/PreviewShell/Settings)
// are themselves made fluid (see the responsive-desktop plan). Every app
// (`projects/maple`, `projects/maple-syrup`) wraps its root `<app-root>`
// template in `<app-root-shell />` so the update toast + LAN-switch banner
// live in one place.
//
// Plan: docs/superpowers/plans/2026-07-25-web-responsive-desktop.md Task 1.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppUpdateService } from '../sw/app-update.service';
import { LanSwitchBannerComponent } from '../network/lan-switch-banner.component';
import { GpuFallbackNoticeService } from '../components/gpu-fallback-notice/gpu-fallback-notice.service';
import { MuiStatusTextComponent } from '../ui/status-text/mui-status-text.component';
import { MuiToastContainerComponent } from '../ui/toast-container/mui-toast-container.component';
import { SidecarSaveStateService } from '../xmp/sidecar-save-state.service';

@Component({
  selector: 'app-root-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    LanSwitchBannerComponent,
    MuiStatusTextComponent,
    MuiToastContainerComponent,
  ],
  // The LAN-switch banner is a no-op on the Hosted build (see its
  // LIBRARY_BACKEND gate) — safe to always mount here. The GPU fallback
  // notice (#2415) only ever becomes visible once the editor has actually
  // attempted (and lost) a GPU live session, so it's likewise a safe no-op
  // everywhere else.
  templateUrl: './root-shell.component.html',
  styleUrl: './root-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RootShellComponent {
  // Replaces the deleted `maple-save-status` wrapper (MW2, #3029) — the
  // phase→presentation mapping now lives on the service itself
  // (`SidecarSaveStateService.statusText`) since both this shell and
  // maple-syrup's `HostedRootShellComponent` render the exact same thing
  // from it.
  protected readonly saveState = inject(SidecarSaveStateService);
  // Replaces the deleted `UpdateToastComponent` / `GpuFallbackNoticeComponent`
  // wrappers (toast sweep, ticket #3043) — same pattern as `saveState`
  // above: each service exposes its own `toasts` presentation mapping, and
  // this shell (plus maple-syrup's `HostedRootShellComponent`) binds it
  // straight into `<mui-toast-container>`.
  protected readonly updates = inject(AppUpdateService);
  protected readonly gpuFallback = inject(GpuFallbackNoticeService);
}
