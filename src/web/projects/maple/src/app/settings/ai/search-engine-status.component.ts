import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, EMPTY, filter, interval, switchMap } from 'rxjs';
import { AiApiService } from '@maple-common';
import type { SearchEngineView } from '@maple-common';

const REFRESH_MS = 5_000;

function stillLoading(view: SearchEngineView | null): boolean {
  return view !== null && !(view.status.phase === 'ready' && view.status.textReady);
}

/** The stored model names the engine counts as its own, e.g. `bge-m3 or bge-m3:latest`. */
function modelIdentity(status: SearchEngineView['status']): string {
  return status.matchedModels?.join(' or ') ?? status.model ?? 'bge-m3';
}

/** One line on how far the in-process search engine has loaded. */
export function engineStatusLine(view: SearchEngineView | null): string | null {
  if (!view) return null;
  const { status } = view;
  const vectors = status.vectors.toLocaleString();
  switch (status.phase) {
    case 'ready':
      return [
        status.textReady
          ? `Ready — ${vectors} photos indexed`
          : `Ready — ${vectors} photos; keyword index still building`,
        status.model ? ` with vectors tagged ${modelIdentity(status)}` : '',
        status.skippedVectors
          ? `; ${status.skippedVectors.toLocaleString()} vectors from other models skipped`
          : '',
        '.',
      ].join('');
    case 'empty':
      return `No search vectors tagged ${modelIdentity(status)} yet — the embed stage on Settings → Workers builds them. Searches use the keyword index until then.`;
    case 'failed':
      return `Could not start: ${status.error ?? 'unknown error'}. Searches use the keyword index until it does.`;
    case 'stopped':
      return 'Not running.';
    default:
      return 'Loading the model and vectors… searches use the keyword index until it is ready.';
  }
}

@Component({
  selector: 'maple-search-engine-status',
  standalone: true,
  templateUrl: './search-engine-status.component.html',
  styleUrl: './search-engine-status.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchEngineStatusComponent implements OnInit {
  private readonly api = inject(AiApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly view = signal<SearchEngineView | null>(null);
  readonly error = signal('');
  readonly statusLine = computed(() => engineStatusLine(this.view()));

  ngOnInit(): void {
    this.api
      .getSearchEngine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => this.view.set(view),
        error: () => this.error.set('Could not load the search engine status.'),
      });
    interval(REFRESH_MS)
      .pipe(
        filter(() => stillLoading(this.view())),
        switchMap(() => this.api.getSearchEngine().pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((view) => this.view.set(view));
  }
}
