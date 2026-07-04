// ImportsComponent — `/settings/imports` (auth-gated, owner-only via nav).
//
// Flow (ticket #742): choose a target library → browse a server-local folder
// (starting at the filesystem root, never inside the library) → scan into
// editable YEAR/MM buckets → import, then watch progress. Originals are
// copied, never moved. The server jails the source to MAPLE_ROOTS, rejects a
// source that overlaps the target library, and re-validates every bucket
// label — the UI's checks are a convenience, not the security boundary.
//
// Buckets group by CAPTURE time (EXIF, falling back to file mtime when a
// file has no EXIF date), not raw file mtime — so a bucket's Year/Month
// matches the date Maple shows for those photos everywhere else.
//
// A bucket's label field starts BLANK, not pre-filled with the month: leaving
// it blank means "use the server default" (an already-indexed photo within 30
// minutes wins first, then `<year>/misc/<source folder name>`, or
// `<year>/<parent folder>/<source folder>` when the source folder is an
// anonymous camera dump name like `Shot0123`/`0123`/`012`). Typing a value
// overrides all of that for just that bucket. Each bucket row shows the
// ACTUAL resolved destination (`ImportScanBucket.defaultDest`, or the
// nearby-match folder for some of its files) so it's never ambiguous where a
// group of photos is about to land — see `effectiveDest()`.
//
// Deep link: `/settings/imports?job=<id>` jumps straight to a running
// import's live status (the link the Workers page hands out).

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, Subscription, timer, switchMap } from 'rxjs';
import {
  BunApiBackendService,
  FilesystemBrowseService,
  ImportsApiService,
  type ApiFolder,
  type FsDirListing,
  type ImportScanBucket,
  type ImportScanResult,
  type ImportSummary,
  errorMessage,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

type Step = 'pick' | 'review' | 'progress';

/** True when `source` IS the library or sits INSIDE it. We only block this
 * direction — a parent of the library (e.g. `/`) is a fine place to browse
 * from and to import loose files out of; the library's own files dedup-skip.
 * Blocking ancestors would wrongly flag every folder on the way down from `/`. */
function isInsideLibrary(source: string, lib: string): boolean {
  const s = source.replace(/\/+$/, '') || '/';
  const l = lib.replace(/\/+$/, '') || '/';
  if (s === l) return true;
  const lPrefix = l === '/' ? '/' : l + '/';
  return s.startsWith(lPrefix);
}

@Component({
  selector: 'maple-imports',
  standalone: true,
  imports: [FormsModule, RouterLink, SettingsShellComponent, SettingsIconComponent],
  templateUrl: './imports.component.html',
  styleUrl: './imports.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportsComponent implements OnInit, OnDestroy {
  private readonly api = inject(ImportsApiService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly backend = inject(BunApiBackendService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly step = signal<Step>('pick');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Set after an import is queued, so the pick screen shows a "running"
   * notice; cleared once the user starts choosing the next import. */
  protected readonly started = signal<'manual' | 'auto' | null>(null);

  // --- Target library (chosen FIRST) ---------------------------------------
  protected readonly libraries = signal<ApiFolder[]>([]);
  protected readonly targetLibraryId = signal<string>('');
  protected readonly libRoot = computed(
    () => this.libraries().find((l) => l.id === this.targetLibraryId())?.path ?? null,
  );

  // --- Source folder picker (starts at the filesystem root) ----------------
  private readonly roots = signal<string[]>([]);
  protected readonly listing = signal<FsDirListing | null>(null);
  protected readonly currentPath = computed(() => this.listing()?.path ?? null);
  protected readonly atRoot = computed(() => this.listing()?.parent == null);
  protected readonly selectedSource = signal<string | null>(null);

  /** The folder the picker is sitting in can't be used as the source when it
   * is the target library itself or a folder inside it (copy-into-self /
   * duplicates). Ancestors like `/` are fine. */
  protected readonly currentBlocked = computed(() => {
    const p = this.currentPath();
    const lib = this.libRoot();
    return !!p && !!lib && isInsideLibrary(p, lib);
  });

  // --- Scan ----------------------------------------------------------------
  protected readonly scan = signal<ImportScanResult | null>(null);
  /** Editable per-bucket labels, keyed on the `${year}/${mm}` bucket key.
   * A key absent (or blank) here means "use the server default" for that
   * bucket — see the class-level comment above. */
  protected readonly labels = signal<Record<string, string>>({});

  // --- Progress ------------------------------------------------------------
  protected readonly active = signal<ImportSummary | null>(null);
  private poll: Subscription | null = null;

  protected readonly percent = computed(() => {
    const a = this.active();
    if (!a || a.progress.total === 0) return 0;
    return Math.round((a.progress.current / a.progress.total) * 100);
  });
  protected readonly terminal = computed(() => {
    const s = this.active()?.status;
    return s === 'done' || s === 'failed' || s === 'cancelled';
  });

  async ngOnInit(): Promise<void> {
    try {
      const [libs, roots] = await Promise.all([
        firstValueFrom(this.backend.listFolders()),
        firstValueFrom(this.fsBrowse.roots()),
      ]);
      this.libraries.set(libs);
      this.roots.set(roots);
    } catch (e) {
      this.error.set(this.msg(e));
    }

    // Deep link to a specific import's status (the Workers-page link).
    const job = this.route.snapshot.queryParamMap.get('job');
    if (job) {
      this.step.set('progress');
      this.startPolling(job);
    }
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
  }

  // --- Library + picker actions --------------------------------------------

  async onLibraryChange(id: string): Promise<void> {
    this.targetLibraryId.set(id);
    this.selectedSource.set(null);
    this.error.set(null);
    // Open the picker at the filesystem root so the source is chosen from `/`,
    // not from inside a library.
    const start = this.roots()[0] ?? '/';
    await this.open(start);
  }

  async open(absPath: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.listing.set(await firstValueFrom(this.fsBrowse.listDir(absPath)));
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Go up one level; no-op at the jail root (parent is null). */
  async up(): Promise<void> {
    const parent = this.listing()?.parent;
    if (parent) await this.open(parent);
  }

  useFolder(absPath: string): void {
    if (this.currentBlocked()) return;
    this.started.set(null); // committing to a new import — drop the prior notice
    this.selectedSource.set(absPath);
  }

  clearSource(): void {
    this.selectedSource.set(null);
  }

  // --- Scan ----------------------------------------------------------------

  async runScan(): Promise<void> {
    const src = this.selectedSource();
    const lib = this.targetLibraryId();
    if (!src || !lib) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await firstValueFrom(this.api.scan(src, lib));
      if (result.totals.files === 0) {
        this.error.set('No importable photos, sidecars, or movies in that folder.');
        return;
      }
      this.scan.set(result);
      this.labels.set({});
      this.step.set('review');
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  setLabel(key: string, value: string): void {
    this.labels.update((m) => ({ ...m, [key]: value }));
  }

  /** True when the user has typed an explicit label override for this
   * bucket. An override always wins over a nearby-asset match (see
   * buildImportFiles's precedence in scan.ts), so the nearby-match note must
   * hide once one is set — otherwise the review screen would claim files
   * will "join existing photos" when they're actually going to the
   * user-typed folder. */
  protected hasOverride(bucket: ImportScanBucket): boolean {
    return (this.labels()[bucket.key] ?? '').trim().length > 0;
  }

  /** The destination a bucket's files will ACTUALLY land in, reflecting the
   * user's current (possibly still-being-typed) label override — so the
   * review screen never shows a stale or ambiguous folder. */
  protected effectiveDest(bucket: ImportScanBucket): string {
    const override = (this.labels()[bucket.key] ?? '').trim();
    return override.length > 0 ? `${bucket.year}/${override}` : bucket.defaultDest;
  }

  backToPick(): void {
    this.scan.set(null);
    this.step.set('pick');
  }

  // --- Import + progress ---------------------------------------------------

  /** Import the reviewed buckets (manual path). */
  async startImport(): Promise<void> {
    await this.queue('manual', { labels: this.labels() });
  }

  /** Auto Import — queue immediately; the worker scans + resolves destinations
   * (the default folder — see the class-level comment above). */
  async autoImport(): Promise<void> {
    await this.queue('auto', { auto: true });
  }

  /** Shared create + return-to-start-with-notice for both import paths. */
  private async queue(
    kind: 'manual' | 'auto',
    body: { labels?: Record<string, string>; auto?: boolean },
  ): Promise<void> {
    const src = this.selectedSource();
    const lib = this.targetLibraryId();
    if (!src || !lib) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.create({ source_root: src, library_id: lib, ...body }));
      // Return to the start screen so another import can be queued; the job
      // runs in the background and is tracked on the Workers page.
      this.started.set(kind);
      this.selectedSource.set(null);
      this.scan.set(null);
      this.labels.set({});
      this.step.set('pick');
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.busy.set(false);
    }
  }

  private startPolling(id: string): void {
    this.poll?.unsubscribe();
    this.poll = timer(0, 1500)
      .pipe(switchMap(() => this.api.poll(id)))
      .subscribe({
        next: (doc) => {
          this.active.set(doc);
          if (this.terminal()) this.poll?.unsubscribe();
        },
        error: (e) => this.error.set(this.msg(e)),
      });
  }

  async cancel(): Promise<void> {
    const a = this.active();
    if (!a) return;
    try {
      await firstValueFrom(this.api.cancel(a.id));
    } catch (e) {
      this.error.set(this.msg(e));
    }
  }

  /** Start over with a fresh pick. */
  async reset(): Promise<void> {
    this.poll?.unsubscribe();
    this.active.set(null);
    this.scan.set(null);
    this.selectedSource.set(null);
    this.labels.set({});
    this.error.set(null);
    this.step.set('pick');
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {},
    });
  }

  protected libraryLabel(id: string): string {
    return this.libraries().find((l) => l.id === id)?.label ?? id;
  }

  private msg(e: unknown): string {
    return errorMessage(e);
  }
}
