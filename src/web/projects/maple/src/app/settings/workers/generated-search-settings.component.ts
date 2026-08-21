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
  WorkersApiService,
  errorMessage,
  type GeneratedSearchCard,
  type GeneratedSearchConfig,
} from '@maple-common';
import { SettingsRowComponent } from '../settings-row.component';
import { SettingsIconComponent } from '../settings-icon.component';
import {
  GeneratedSearchKnobsComponent,
  type GeneratedSearchDraft,
} from './generated-search-knobs.component';
import { GeneratedSearchCollectionsComponent } from './generated-search-collections.component';

@Component({
  selector: 'maple-generated-search-settings',
  standalone: true,
  imports: [
    SettingsRowComponent,
    SettingsIconComponent,
    GeneratedSearchKnobsComponent,
    GeneratedSearchCollectionsComponent,
  ],
  templateUrl: './generated-search-settings.component.html',
  styleUrl: './generated-search-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneratedSearchSettingsComponent implements OnInit {
  private readonly api = inject(WorkersApiService);

  protected readonly config = signal<GeneratedSearchConfig | null>(null);
  protected readonly cards = signal<GeneratedSearchCard[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
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
  protected readonly chevron = computed(() => (this.expanded() ? 'chev-d' : 'chev-r'));
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
      await this.loadCards();
    } catch (err: unknown) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
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

  /** The library whose collections to show. Single-library installs are the
   * norm; a picker is not worth building until a second library exists. */
  private libraryId(): string | null {
    return this.selectedLibraryId;
  }
  protected selectedLibraryId: string | null = null;

  /** Called by the parent page, which already knows the selected library. */
  setLibrary(id: string | null): void {
    this.selectedLibraryId = id;
    void this.loadCards();
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
      this.saved.set(true);
    } catch (err: unknown) {
      this.error.set(errorMessage(err));
    } finally {
      this.saving.set(false);
    }
  }
}
