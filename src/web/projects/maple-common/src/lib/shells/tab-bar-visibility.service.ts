// tab-bar-visibility.service.ts — responsive-program S1a (#597).
//
// Mirrors SwiftUI's `.toolbar(.hidden, for: .tabBar)` for the web phone
// shell. Push-mode route components (S4 Loupe, S5 Editor) call
// `hidden.set(true)` on init and `hidden.set(false)` on destroy; the
// `PhoneTabShellComponent` reads the signal in its template to add the
// `.hidden` class on the bottom-nav.
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §2.

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TabBarVisibilityService {
  /** True when push-mode content should hide the bottom tab bar. */
  readonly hidden = signal<boolean>(false);
}
