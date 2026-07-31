// root-shell.component.ts — web responsive foundation (#2279).
//
// Top-level shell. Always renders the pane `<router-outlet />` — the phone-
// tab shell fork (S1a, #597) that switched on LayoutService.layout() is
// retired; the pane shells (BrowseShell/EditorShell/PreviewShell/Settings)
// are themselves made fluid (see the responsive-desktop plan). Every app
// (`projects/maple`, `projects/maple-syrup`) wraps its root `<app-root>`
// template in `<app-root-shell />` so the update-toast + LAN-switch banner
// live in one place.
//
// Plan: docs/superpowers/plans/2026-07-25-web-responsive-desktop.md Task 1.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UpdateToastComponent } from '../sw/update-toast.component';
import { LanSwitchBannerComponent } from '../network/lan-switch-banner.component';
import { GpuFallbackNoticeComponent } from '../components/gpu-fallback-notice/gpu-fallback-notice.component';

@Component({
  selector: 'app-root-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    UpdateToastComponent,
    LanSwitchBannerComponent,
    GpuFallbackNoticeComponent,
  ],
  // The LAN-switch banner is a no-op on the Hosted build (see its
  // LIBRARY_BACKEND gate) — safe to always mount here. The GPU fallback
  // notice (#2415) only ever becomes visible once the editor has actually
  // attempted (and lost) a GPU live session, so it's likewise a safe no-op
  // everywhere else.
  template: `
    <router-outlet />
    <maple-update-toast />
    <maple-lan-switch-banner />
    <maple-gpu-fallback-notice />
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RootShellComponent {}
