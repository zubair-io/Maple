import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, catchError, map, of, startWith } from 'rxjs';
import { marked } from 'marked';
import { MAPLE_UI_COLORS, MAPLE_UI_MOTION, MAPLE_UI_RADIUS, MAPLE_UI_SPACING } from '@maple-common';
import { MapleUiContract, MapleUiDocsService } from './maple-ui-docs.service';
import { TierAtomsComponent } from './tiers/tier-atoms.component';
import { TierMolecules1FormComponent } from './tiers/tier-molecules1-form.component';
import { TierMolecules1StructureComponent } from './tiers/tier-molecules1-structure.component';
import { TierMolecules2Component } from './tiers/tier-molecules2.component';
import { TierOrganismsCollectionsComponent } from './tiers/tier-organisms-collections.component';
import { TierOrganismsModalsComponent } from './tiers/tier-organisms-modals.component';
import { TierTemplatesComponent } from './tiers/tier-templates.component';
import { TierPagesComponent } from './tiers/tier-pages.component';

interface ContractVm {
  readonly slug: string;
  readonly title: string;
  /** Contract markdown rendered to HTML. Sanitized by Angular's [innerHTML] binding. */
  readonly html: string;
}

type DocsVm =
  | { readonly state: 'loading' }
  | { readonly state: 'error' }
  | { readonly state: 'ready'; readonly contracts: readonly ContractVm[] };

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
// The Material Symbols Rounded stylesheet is injected only when this page
// loads, so the external font dependency never touches the rest of the app.
@Component({
  selector: 'app-maple-ui-page',
  imports: [
    TierAtomsComponent,
    TierMolecules1FormComponent,
    TierMolecules1StructureComponent,
    TierMolecules2Component,
    TierOrganismsCollectionsComponent,
    TierOrganismsModalsComponent,
    TierTemplatesComponent,
    TierPagesComponent,
  ],
  templateUrl: './maple-ui-page.component.html',
  styleUrl: './maple-ui-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleUiPageComponent {
  private readonly docs = inject(MapleUiDocsService);

  readonly tabs = CATALOG_TABS;
  readonly activeTab = signal<CatalogTab>('atoms');

  readonly colorTokens = Object.entries(MAPLE_UI_COLORS).map(([key, value]) => ({ key, value }));
  readonly radiusTokens = Object.entries(MAPLE_UI_RADIUS).map(([key, value]) => ({
    key,
    px: value,
  }));
  readonly spacingTokens = Object.entries(MAPLE_UI_SPACING).map(([key, value]) => ({
    key,
    px: value,
  }));
  readonly motionTokens = Object.entries(MAPLE_UI_MOTION).map(([key, spec]) => ({
    key,
    ms: spec.ms,
    ease: spec.ease,
  }));

  private readonly docsStream: Observable<DocsVm> = this.docs.contracts().pipe(
    map(
      (contracts): DocsVm => ({
        state: 'ready',
        contracts: contracts.map((contract) => toContractVm(contract)),
      }),
    ),
    startWith<DocsVm>({ state: 'loading' }),
    catchError(() => of<DocsVm>({ state: 'error' })),
  );

  private readonly docsVm = toSignal(this.docsStream, {
    initialValue: { state: 'loading' } as DocsVm,
  });

  readonly loading = computed(() => this.docsVm().state === 'loading');
  readonly loadFailed = computed(() => this.docsVm().state === 'error');
  readonly contracts = computed(() => {
    const vm = this.docsVm();
    return vm.state === 'ready' ? vm.contracts : [];
  });

  constructor() {
    ensureMaterialSymbolsLoaded();
  }

  selectTab(tab: CatalogTab): void {
    this.activeTab.set(tab);
  }
}

function toContractVm(contract: MapleUiContract): ContractVm {
  // Strip the doc's own `# Title` line — the card header renders the title.
  const body = contract.markdown.replace(/^# .*\n/, '');
  return {
    slug: contract.slug,
    title: contract.title,
    html: marked.parse(body, { async: false }),
  };
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
