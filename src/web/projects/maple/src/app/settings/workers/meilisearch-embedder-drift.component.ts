// Shows when the search index's live `caption` embedder differs from what
// Settings configures, and applies Settings to it only on an explicit,
// confirmed click: for an Ollama embedder Meilisearch re-embeds every
// document when the url or model changes, so this is never automatic (#4432).
// Backed by GET/POST /api/admin/enrichment/meilisearch-embedder[/apply].

import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  errorMessage,
  MeilisearchEmbedderApiService,
  type MeilisearchEmbedderDrift,
  type MeilisearchEmbedderSummary,
  MuiButtonComponent,
} from '@maple-common';

function describe(embedder: MeilisearchEmbedderSummary | null): string {
  return embedder === null ? 'no embedder' : `${embedder.url ?? '?'} · ${embedder.model ?? '?'}`;
}

@Component({
  selector: 'maple-meilisearch-embedder-drift',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './meilisearch-embedder-drift.component.html',
  host: { class: 'field field-wide set-field', '[hidden]': '!visible()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MeilisearchEmbedderDriftComponent implements OnInit {
  private readonly api = inject(MeilisearchEmbedderApiService);

  protected readonly drift = signal<MeilisearchEmbedderDrift | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);
  protected readonly applying = signal(false);

  protected readonly live = computed(() => describe(this.drift()?.live ?? null));
  protected readonly configured = computed(() => describe(this.drift()?.configured ?? null));
  protected readonly documents = computed(() => {
    const count = this.drift()?.documentCount;
    return count === null || count === undefined
      ? 'every document'
      : `all ${count.toLocaleString()} documents`;
  });
  protected readonly visible = computed(
    () =>
      this.error() !== null ||
      ['drift', 'pending', 'unreachable'].includes(this.drift()?.state ?? ''),
  );
  protected readonly removesEmbedder = computed(() => this.drift()?.configured === null);

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  protected async refresh(): Promise<void> {
    try {
      this.drift.set(await firstValueFrom(this.api.getDrift()));
      this.error.set(null);
    } catch (e) {
      // Members cannot read admin index state; the panel simply stays hidden.
      const forbidden = e instanceof HttpErrorResponse && e.status === 403;
      this.error.set(forbidden ? null : errorMessage(e));
    }
  }

  protected async apply(): Promise<void> {
    this.applying.set(true);
    try {
      await firstValueFrom(this.api.apply());
      this.confirming.set(false);
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.applying.set(false);
    }
  }
}
