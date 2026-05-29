// phone-tab-shell.component.ts — responsive-program S1a (#597).
//
// Phone-tier shell with a bottom tab bar (Library / Search / Settings).
// Each tab route loads in the <router-outlet>; the tab bar hides when
// `TabBarVisibilityService.hidden()` flips true (consumed by S4 Loupe
// and S5 Editor push routes).
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §2.2.
//
// Icons are inlined SVG until S0c (#589) lands a `gear` glyph in
// `maple-icon-registry`. `photos` and `search` exist on main already
// but we keep all three inline for consistency.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TabBarVisibilityService } from './tab-bar-visibility.service';

@Component({
  selector: 'app-phone-tab-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './phone-tab-shell.component.html',
  styleUrl: './phone-tab-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneTabShellComponent {
  private readonly visibility = inject(TabBarVisibilityService);
  protected readonly tabBarHidden = this.visibility.hidden;
}
