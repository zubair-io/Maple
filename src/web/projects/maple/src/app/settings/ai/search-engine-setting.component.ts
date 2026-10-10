import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, EMPTY, filter, interval, switchMap } from 'rxjs';
import { AiApiService, MuiSegmentedToggleComponent } from '@maple-common';
import type { SearchEngineName, SearchEngineView } from '@maple-common';

const REFRESH_MS = 5_000;

const ENGINE_OPTIONS: ReadonlyArray<{ value: SearchEngineName; label: string }> = [
  { value: 'meilisearch', label: 'Meilisearch' },
  { value: 'in-process', label: 'In-process' },
];

function isEngine(value: string): value is SearchEngineName {
  return ENGINE_OPTIONS.some((option) => option.value === value);
}

function stillLoading(view: SearchEngineView | null): boolean {
  return view?.engine === 'in-process' && !(view.status.phase === 'ready' && view.status.textReady);
}

/** One line on how far the in-process engine has loaded; null while Meilisearch is selected. */
export function engineStatusLine(view: SearchEngineView | null): string | null {
  if (!view || view.engine !== 'in-process') return null;
  const { status } = view;
  const vectors = status.vectors.toLocaleString();
  switch (status.phase) {
    case 'ready':
      return [
        status.textReady
          ? `Ready — ${vectors} photos indexed`
          : `Ready — ${vectors} photos; keyword index still building`,
        status.model ? ` with ${status.model}` : '',
        status.skippedVectors
          ? `; ${status.skippedVectors.toLocaleString()} vectors from other models skipped`
          : '',
        '.',
      ].join('');
    case 'failed':
      return `Could not start: ${status.error ?? 'unknown error'}. Searches use Meilisearch until it does.`;
    case 'stopped':
      return 'Not running.';
    default:
      return 'Loading the model and vectors… searches use Meilisearch until it is ready.';
  }
}

@Component({
  selector: 'maple-search-engine-setting',
  standalone: true,
  imports: [MuiSegmentedToggleComponent],
  templateUrl: './search-engine-setting.component.html',
  styleUrl: './search-engine-setting.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchEngineSettingComponent implements OnInit {
  private readonly api = inject(AiApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly options = ENGINE_OPTIONS;
  readonly view = signal<SearchEngineView | null>(null);
  /** What the toggle shows: the saved engine, or the one being saved until the save settles. */
  readonly selected = linkedSignal<SearchEngineName>(() => this.view()?.engine ?? 'meilisearch');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly statusLine = computed(() => engineStatusLine(this.view()));

  ngOnInit(): void {
    this.api
      .getSearchEngine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => this.view.set(view),
        error: () => this.error.set('Could not load the search engine setting.'),
      });
    interval(REFRESH_MS)
      .pipe(
        filter(() => stillLoading(this.view()) && !this.saving()),
        switchMap(() => this.api.getSearchEngine().pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((view) => this.view.set(view));
  }

  select(engine: string): void {
    const saved = this.view()?.engine;
    if (!isEngine(engine) || engine === saved || this.saving()) return;
    this.selected.set(engine);
    this.saving.set(true);
    this.error.set('');
    this.api
      .setSearchEngine(engine)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.view.set(view);
          this.saving.set(false);
        },
        error: () => {
          this.error.set('Could not switch the search engine. Try again.');
          this.selected.set(saved ?? 'meilisearch');
          this.saving.set(false);
        },
      });
  }
}
