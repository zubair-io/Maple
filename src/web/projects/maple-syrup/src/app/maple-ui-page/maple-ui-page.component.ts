import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, catchError, map, of, startWith } from 'rxjs';
import { marked } from 'marked';
import { MAPLE_UI_COLORS, MAPLE_UI_MOTION, MAPLE_UI_RADIUS, MAPLE_UI_SPACING } from '@maple-common';
import { MapleUiContract, MapleUiDocsService } from './maple-ui-docs.service';

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

// Public component gallery for the Maple UI design system (#3000).
// Tokens render live from the generated `MAPLE_UI_*` tables; the component
// cards render the actual contract docs synced into public assets — the
// page cannot drift from the system because it renders the system's own
// source files.
@Component({
  selector: 'app-maple-ui-page',
  templateUrl: './maple-ui-page.component.html',
  styleUrl: './maple-ui-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleUiPageComponent {
  private readonly docs = inject(MapleUiDocsService);

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
