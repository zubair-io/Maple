// phone-settings-stub.component.ts — responsive-program S1a (#597).
//
// Placeholder for the Settings tab. S8 will replace with an iOS Settings-
// style List grouping General / Backup / Self Hosted / Files. For now we
// render a labelled placeholder so the route resolves and the tab is
// visibly correct end-to-end.

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-phone-settings-stub',
  standalone: true,
  template: `
    <header>
      <h1>Settings</h1>
    </header>
    <p>Settings — coming in S8</p>
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 12px;
        color: var(--mpl-text, #e8e6e3);
      }
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 4px 0 12px;
      }
      p {
        color: var(--mpl-text-secondary, #a8a29e);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneSettingsStubComponent {}
