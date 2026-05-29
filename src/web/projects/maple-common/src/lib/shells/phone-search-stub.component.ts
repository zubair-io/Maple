// phone-search-stub.component.ts — responsive-program S1a (#597).
//
// Placeholder content for the Search tab. S7 will replace with real
// search results UI. For now we render the Search header chrome (a
// disabled search field stub) so the tab is visibly correct end-to-end.

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-phone-search-stub',
  standalone: true,
  template: `
    <header>
      <input type="search" placeholder="Search" disabled aria-label="Search photos" />
    </header>
    <p>Search — coming in S7</p>
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 12px;
        color: var(--mpl-text, #e8e6e3);
      }
      header {
        margin-bottom: 12px;
      }
      input {
        width: 100%;
        height: 36px;
        border-radius: 18px;
        border: 1px solid var(--mpl-border, #44403c);
        background: var(--mpl-surface, #2a2725);
        color: inherit;
        padding: 0 14px;
        font: inherit;
      }
      p {
        color: var(--mpl-text-secondary, #a8a29e);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneSearchStubComponent {}
