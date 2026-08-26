// GeneratedSearchSettingsComponent — the "Generated Searches" panel on the
// Workers settings page.
//
// Two jobs, and the second is the point of the feature: operate the daily run
// (enable it, retune it, dry-run it), and SHOW what it came up with. The
// collections are LLM-invented and deliberately non-deterministic, so reading
// them is part of using the product — each row links into /search with the
// same filters, which is how you check whether a theme actually found the
// photos it claims.
//
// Backed by GET/PATCH /api/workers/generated-search/config and
// GET /api/generated-searches. Modeled on DerivativeAuditSettingsComponent
// (same signals + draft-then-save shape).

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
  BunApiBackendService,
  WorkersApiService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiSettingsRowComponent,
  type GeneratedSearchCard,
  type GeneratedSearchConfig,
} from '@maple-common';
import {
  GeneratedSearchKnobsComponent,
  type GeneratedSearchDraft,
} from './generated-search-knobs.component';
import { GeneratedSearchCollectionsComponent } from './generated-search-collections.component';

@Component({
  selector: 'maple-generated-search-settings',
  standalone: true,
  imports: [
    MuiSettingsRowComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    GeneratedSearchKnobsComponent,
    GeneratedSearchCollectionsComponent,
  ],
  templateUrl: './generated-search-settings.component.html',
  styleUrl: './generated-search-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneratedSearchSettingsComponent implements OnInit {
  private readonly api = inject(WorkersApiService);
  private readonly backend = inject(BunApiBackendService);

  protected readonly config = signal<GeneratedSearchConfig | null>(null);
  protected readonly cards = signal<GeneratedSearchCard[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  /** True from clicking "Run now" until the refreshed collections land. */
  protected readonly running = signal(false);
  protected readonly draft = signal<GeneratedSearchDraft | null>(null);

  /** Collapsed by default, matching the stage rows on this page. */
  protected readonly expanded = signal(false);
  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  /** Paused is the master switch, so it reads as its own control rather than
   * as one knob among many. */
  protected readonly enabled = computed(() => this.config()?.paused === false);

  /** Presentation ternaries live here rather than in the template: each one
   * is a branch the template complexity budget counts, and they read better
   * named. */
  protected readonly statusColor = computed(() => (this.enabled() ? '#4ade80' : '#a8a29e'));
  protected readonly statusLabel = computed(() => (this.enabled() ? 'running' : 'paused'));

  /** One-line readout for the collapsed row — mirrors how the other worker
   * rows summarise themselves. */
  protected readonly summaryLine = computed(() => {
    const config = this.config();
    if (config === null) return '';
    const count = this.cards().length;
    if (!this.enabled()) return `paused · ${config.collections_per_day}/day when enabled`;
    return count === 0 ? 'no collections yet' : `${count} collections today`;
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const config = await firstValueFrom(this.api.getGeneratedSearchConfig());
      this.config.set(config);
      this.draft.set({
        collections_per_day: config.collections_per_day,
        min_results: config.min_results,
        max_rounds: config.max_rounds,
        retention_days: config.retention_days,
        model: config.model,
        dry_run: config.dry_run,
      });
      await this.resolveLibrary();
      await this.loadCards();
    } catch (err: unknown) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Resolve which library to read collections for. A failure is swallowed:
   * the config half of the panel still works without it. */
  private async resolveLibrary(): Promise<void> {
    try {
      const folders = await firstValueFrom(this.backend.listFolders());
      this.libraryId.set(folders[0]?.id ?? null);
    } catch {
      this.libraryId.set(null);
    }
  }

  /** Today's collections. A failure here is NOT surfaced as a page error:
   * the config half still works, and an empty list is indistinguishable to
   * the operator from "no run yet", which is the common case. */
  private async loadCards(): Promise<void> {
    const libraryId = this.libraryId();
    if (libraryId === null) return;
    try {
      const response = await firstValueFrom(this.api.getGeneratedSearches(libraryId));
      this.cards.set(response.results);
    } catch {
      this.cards.set([]);
    }
  }

  /** The library whose collections to show, resolved from the registered
   * folders. Single-library installs are the norm, so the first registered
   * library is the right default; a picker is not worth building until a
   * second one exists. */
  protected readonly libraryId = signal<string | null>(null);

  /** How long to let a kicked pass run before refreshing the list. A field
   * (not a constant) so the spec can zero it instead of waiting wall-clock. */
  protected refreshDelayMs = 4000;

  /** Kick a pass immediately — the scheduled tick can be up to a day away,
   * and this is the answer to "I just enabled it, why is nothing happening?".
   * A pass takes minutes (LLM calls), so this waits briefly then refreshes
   * the list; a still-running pass simply shows up on the next panel load.
   *
   * `started: false` (already-running) takes the SAME wait-and-refresh path:
   * a pass is in flight either way, so "Running…" stays honest and the
   * button stays disabled instead of inviting repeated POSTs. */
  protected async runNow(): Promise<void> {
    this.running.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.runGeneratedSearchNow());
      await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
      await this.loadCards();
    } catch (err: unknown) {
      this.error.set(errorMessage(err));
    } finally {
      this.running.set(false);
    }
  }

  protected async toggleEnabled(): Promise<void> {
    const config = this.config();
    if (config === null) return;
    await this.patch({ paused: !config.paused });
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (draft === null) return;
    await this.patch(draft);
  }

  private async patch(patch: Partial<GeneratedSearchConfig>): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      // The server clamps rather than rejecting, and answers with what it
      // stored — so adopt the response instead of the optimistic local value.
      const response = await firstValueFrom(this.api.patchGeneratedSearchConfig(patch));
      this.config.set(response.config);
      // The draft has to adopt the stored values too. The server clamps, so
      // leaving the draft alone would keep showing the pre-clamp number the
      // operator typed and quietly disagree with what was actually saved.
      this.draft.set({
        collections_per_day: response.config.collections_per_day,
        min_results: response.config.min_results,
        max_rounds: response.config.max_rounds,
        retention_days: response.config.retention_days,
        model: response.config.model,
        dry_run: response.config.dry_run,
      });
      this.saved.set(true);
    } catch (err: unknown) {
      this.error.set(errorMessage(err));
    } finally {
      this.saving.set(false);
    }
  }
}
