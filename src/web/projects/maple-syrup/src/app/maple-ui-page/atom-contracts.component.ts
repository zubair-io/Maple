import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, catchError, map, of, startWith } from 'rxjs';
import { marked } from 'marked';
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

// Atom contracts section of the Unified Component Catalog's Atoms tab
// (#3000). Renders the binding specification for each implemented atom
// from the same contract documents CI lints — fetched from the copies
// synced into public assets by scripts/sync-maple-ui-docs.mjs.
@Component({
  selector: 'app-atom-contracts',
  templateUrl: './atom-contracts.component.html',
  styleUrl: './atom-contracts.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AtomContractsComponent {
  private readonly docs = inject(MapleUiDocsService);

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
