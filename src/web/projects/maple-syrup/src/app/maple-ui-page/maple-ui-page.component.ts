import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { AtomContractsComponent } from './atom-contracts.component';
import { TierTokensComponent } from './tier-tokens.component';
import { TierAtomsComponent } from './tiers/tier-atoms.component';
import { TierMolecules1FormComponent } from './tiers/tier-molecules1-form.component';
import { TierMolecules1StructureComponent } from './tiers/tier-molecules1-structure.component';
import { TierMolecules2Component } from './tiers/tier-molecules2.component';
import { TierOrganismsCollectionsComponent } from './tiers/tier-organisms-collections.component';
import { TierOrganismsEditingComponent } from './tiers/tier-organisms-editing.component';
import { TierOrganismsModalsComponent } from './tiers/tier-organisms-modals.component';
import { TierTemplatesComponent } from './tiers/tier-templates.component';
import { TierPagesComponent } from './tiers/tier-pages.component';

export type CatalogTab =
  | 'tokens'
  | 'atoms'
  | 'molecules1'
  | 'molecules2'
  | 'organisms'
  | 'templates'
  | 'pages';

export const CATALOG_TABS: readonly { readonly id: CatalogTab; readonly label: string }[] = [
  { id: 'tokens', label: '0 Tokens' },
  { id: 'atoms', label: '1 Atoms' },
  { id: 'molecules1', label: '2 Molecules L1' },
  { id: 'molecules2', label: '3 Molecules L2' },
  { id: 'organisms', label: '4 Organisms' },
  { id: 'templates', label: '5 Templates' },
  { id: 'pages', label: '6 Pages' },
];

// Public Unified Component Catalog for the Maple UI design system (#3000),
// implementing the Canvas.dc.html design from the claude.ai/design project.
// Tier specimens are ported verbatim from that canvas; tokens render live
// from the generated MAPLE_UI_* tables; the atom-contract cards render the
// actual contract docs synced into public assets — the page cannot drift
// from the system because it renders the system's own sources.
//
// The shell only owns tab state and chrome; the tokens tab and the atom
// contracts section are their own components (app-tier-tokens,
// app-atom-contracts) to keep this template's complexity down.
//
// The Material Symbols Rounded stylesheet is injected only when this page
// loads, so the external font dependency never touches the rest of the app.
@Component({
  selector: 'app-maple-ui-page',
  imports: [
    TierTokensComponent,
    AtomContractsComponent,
    TierAtomsComponent,
    TierMolecules1FormComponent,
    TierMolecules1StructureComponent,
    TierMolecules2Component,
    TierOrganismsCollectionsComponent,
    TierOrganismsModalsComponent,
    TierOrganismsEditingComponent,
    TierTemplatesComponent,
    TierPagesComponent,
  ],
  templateUrl: './maple-ui-page.component.html',
  // Fixed height, not min-height: the global shell styles put
  // `overflow: hidden` on html/body, so this host must be the scroll
  // container — same pattern as landing.component.ts.
  host: {
    class: 'block h-screen bg-[#fdfbf7] text-[#292524] overflow-auto font-[Lato,_sans-serif]',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleUiPageComponent {
  readonly tabs = CATALOG_TABS;
  readonly activeTab = signal<CatalogTab>('atoms');

  constructor() {
    ensureMaterialSymbolsLoaded();
  }

  selectTab(tab: CatalogTab): void {
    this.activeTab.set(tab);
  }
}

const MATERIAL_SYMBOLS_LINK_ID = 'maple-ui-material-symbols';

function ensureMaterialSymbolsLoaded(): void {
  if (document.getElementById(MATERIAL_SYMBOLS_LINK_ID)) return;
  const link = document.createElement('link');
  link.id = MATERIAL_SYMBOLS_LINK_ID;
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..600,0..1,0&display=block';
  document.head.appendChild(link);
}
