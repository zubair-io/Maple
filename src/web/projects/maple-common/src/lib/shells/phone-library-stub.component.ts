// phone-library-stub.component.ts — responsive-program S1a (#597).
//
// Placeholder for the Library tab. S1b will wire the source-picker drawer
// (hamburger ☰ → 326pt overlay) and S2 will replace the grid placeholder
// with the real responsive library grid. The header reserves the
// hamburger button slot so S1b only has to wire the drawer state.

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-phone-library-stub',
  standalone: true,
  template: `
    <header>
      <button type="button" class="hamburger" aria-label="Open Library drawer" disabled>
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path
            d="M3 6h16M3 11h16M3 16h16"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <h1>Library</h1>
    </header>
    <p>Grid placeholder — coming in S2</p>
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 12px;
        color: var(--mpl-text, #e8e6e3);
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0 0 12px;
      }
      .hamburger {
        background: transparent;
        border: 0;
        padding: 4px;
        color: inherit;
        cursor: pointer;
        opacity: 0.6;
      }
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 0;
      }
      p {
        color: var(--mpl-text-secondary, #a8a29e);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneLibraryStubComponent {}
