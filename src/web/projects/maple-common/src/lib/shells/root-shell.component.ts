// root-shell.component.ts — responsive-program S1a (#597).
//
// Top-level shell switcher. Reads LayoutService.layout(); on `phone` it
// renders the bottom-tab phone shell, on `tablet` / `desktop` it falls
// through to a plain <router-outlet /> which lets the existing pane
// routes (BrowseShellComponent / EditorShellComponent) render.
//
// Each app (`projects/maple`, `projects/maple-syrup`) wraps its root
// `<app-root>` template in `<app-root-shell />` so the breakpoint logic
// lives in one place. The shell does not duplicate route definitions —
// the route table in each app stays the source of truth.
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §2.2.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LayoutService } from '../layout-service';
import { PhoneTabShellComponent } from './phone-tab-shell.component';

@Component({
  selector: 'app-root-shell',
  standalone: true,
  imports: [RouterOutlet, PhoneTabShellComponent],
  template: `
    @if (layout() === 'phone') {
      <app-phone-tab-shell />
    } @else {
      <router-outlet />
    }
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
export class RootShellComponent {
  private readonly layoutService = inject(LayoutService);
  protected readonly layout = this.layoutService.layout;
}
