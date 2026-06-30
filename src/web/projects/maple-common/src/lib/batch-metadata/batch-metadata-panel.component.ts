// batch-metadata-panel.component.ts — Batch Metadata editor panel (#1606).
// Standalone, OnPush, signals. Observables only at the service layer;
// debounce lives here via toObservable + switchMap.
// Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { BatchMetadataService } from './batch-metadata.service';
import { BatchMetadataConfirmDialogComponent } from './batch-metadata-confirm-dialog.component';
import {
  MIXED,
  type AssetMetadataSnapshot,
  type BatchApplyEntry,
  type BatchApplyMetadata,
  type GeocodeCandidate,
  type MixedValueMap,
} from './batch-metadata.types';
import type { CopyrightStatus } from '../xmp/xmp.types';

type PanelPhase =
  | 'form'
  | 'confirm'
  | 'applying'
  | 'done'
  | 'error'
  | 'refile-offer'
  | 'refile-applying';

/** Human-readable labels for each metadata field (used in confirm summary). */
const FIELD_LABELS: Partial<Record<keyof MixedValueMap, string>> = {
  gpsLatitude: 'GPS Latitude',
  gpsLongitude: 'GPS Longitude',
  gpsAltitude: 'GPS Altitude',
  dateTimeOriginal: 'Capture Date/Time',
  timeZone: 'Time Zone',
  sublocation: 'Sublocation',
  city: 'City',
  state: 'State/Province',
  country: 'Country',
  countryCode: 'Country Code',
  title: 'Title',
  caption: 'Caption (Notes)',
  headline: 'Headline',
  keywords: 'Keywords',
  instructions: 'Instructions',
  creator: 'Creator / Author',
  creatorJobTitle: 'Creator Job Title',
  copyrightNotice: 'Copyright Notice',
  copyrightStatus: 'Copyright Status',
  usageTerms: 'Usage Terms',
  credit: 'Credit',
  source: 'Source',
  rating: 'Rating',
  flag: 'Flag',
  colorLabel: 'Color Label',
};

@Component({
  selector: 'app-batch-metadata-panel',
  standalone: true,
  imports: [FormsModule, BatchMetadataConfirmDialogComponent],
  templateUrl: './batch-metadata-panel.component.html',
  styleUrl: './batch-metadata-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchMetadataPanelComponent implements OnDestroy {
  // ── Inputs / outputs ───────────────────────────────────────────────────────
  readonly visible = input<boolean>(false);
  readonly assetSnapshots = input<AssetMetadataSnapshot[]>([]);
  readonly dismiss = output<void>();

  // ── Services ───────────────────────────────────────────────────────────────
  private readonly svc = inject(BatchMetadataService);

  // ── Phase ─────────────────────────────────────────────────────────────────
  readonly phase = signal<PanelPhase>('form');

  // ── Mixed-value map (recomputed when snapshots change) ────────────────────
  readonly mixed = computed(() => this.svc.computeMixedValues(this.assetSnapshots()));

  // ── Per-field value signals ────────────────────────────────────────────────
  // Initialised to MIXED; overwritten by the user or reset to mixed.
  readonly gpsLatitudeVal = signal<string>('');
  readonly gpsLongitudeVal = signal<string>('');
  readonly gpsAltitudeVal = signal<string>('');
  readonly dateTimeOriginalVal = signal<string>('');
  readonly timeZoneVal = signal<string>('');
  readonly sublocationVal = signal<string>('');
  readonly cityVal = signal<string>('');
  readonly stateVal = signal<string>('');
  readonly countryVal = signal<string>('');
  readonly countryCodeVal = signal<string>('');
  readonly titleVal = signal<string>('');
  readonly captionVal = signal<string>('');
  readonly headlineVal = signal<string>('');
  readonly keywordsVal = signal<string>(''); // comma-separated for text input
  readonly instructionsVal = signal<string>('');
  readonly creatorVal = signal<string>('');
  readonly creatorJobTitleVal = signal<string>('');
  readonly copyrightNoticeVal = signal<string>('');
  readonly copyrightStatusVal = signal<CopyrightStatus | ''>('');
  readonly usageTermsVal = signal<string>('');
  readonly creditVal = signal<string>('');
  readonly sourceVal = signal<string>('');
  readonly ratingVal = signal<string>('');
  readonly flagVal = signal<'pick' | 'reject' | 'unflagged' | '__clear__' | ''>('');
  readonly colorLabelVal = signal<
    'red' | 'orange' | 'yellow' | 'green' | 'blue' | '__clear__' | ''
  >('');

  // ── Per-field touched flags ────────────────────────────────────────────────
  readonly touched = signal<Set<keyof MixedValueMap>>(new Set());

  // ── Geocode state ─────────────────────────────────────────────────────────
  readonly geocodeQuery = signal<string>('');
  readonly geocodeCandidates = signal<GeocodeCandidate[]>([]);
  readonly geocodeLoading = signal<boolean>(false);

  // ── Apply errors ──────────────────────────────────────────────────────────
  readonly applyErrors = signal<Array<{ address: string; error: string }>>([]);
  readonly errorMessage = signal<string>('');

  // ── Refile offer state ────────────────────────────────────────────────────
  /** Number of assets that would be relocated. Set after batchApply succeeds. */
  readonly refileCount = signal<number>(0);
  /** Errors from the refile operation, if any. */
  readonly refileErrors = signal<Array<{ address: string; error: string }>>([]);

  // ── Computed helpers ──────────────────────────────────────────────────────

  readonly assetCount = computed(() => this.assetSnapshots().length);

  /** Human-readable list of touched field labels for the confirm step. */
  readonly touchedFieldLabels = computed(() => {
    const t = this.touched();
    return [...t].map((k) => FIELD_LABELS[k] ?? k);
  });

  readonly confirmVisible = computed(
    () => this.phase() === 'confirm' || this.phase() === 'applying' || this.phase() === 'done',
  );

  readonly applying = computed(() => this.phase() === 'applying');

  readonly refileOfferVisible = computed(
    () => this.phase() === 'refile-offer' || this.phase() === 'refile-applying',
  );

  readonly refileApplying = computed(() => this.phase() === 'refile-applying');

  // ── MIXED sentinel exposed to the template ─────────────────────────────────
  readonly MIXED = MIXED;

  // ── Subscriptions ─────────────────────────────────────────────────────────
  private readonly geocodeSub: Subscription;
  /** Holds the in-flight refile-count or refile subscription for cleanup. */
  private refileSub: Subscription | null = null;

  constructor() {
    // Reset form when the panel opens.
    effect(() => {
      if (this.visible()) {
        this._resetToMixed();
      }
    });

    // Debounced geocode search — observable pipeline, not async.
    this.geocodeSub = toObservable(this.geocodeQuery)
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        // Length check lives inside switchMap (not an upstream `filter`) so that
        // shortening the query to <2 chars still emits and switchMap cancels any
        // in-flight request — avoiding stale candidates from a late response.
        switchMap((q) => {
          const query = q.trim();
          if (query.length < 2) {
            this.geocodeLoading.set(false);
            return of<GeocodeCandidate[]>([]);
          }
          this.geocodeLoading.set(true);
          // catchError INSIDE switchMap: a failed lookup yields [] for that
          // query without erroring (and killing) the long-lived outer pipeline.
          return this.svc.geocodeSearch(query).pipe(
            catchError(() => {
              this.geocodeLoading.set(false);
              return of<GeocodeCandidate[]>([]);
            }),
          );
        }),
      )
      .subscribe((candidates) => {
        this.geocodeLoading.set(false);
        this.geocodeCandidates.set(candidates);
      });
  }

  ngOnDestroy(): void {
    this.geocodeSub.unsubscribe();
    this.refileSub?.unsubscribe();
  }

  // ── Field change handlers ─────────────────────────────────────────────────

  onFieldChange(field: keyof MixedValueMap): void {
    this.touched.update((s) => {
      const next = new Set(s);
      next.add(field);
      return next;
    });
  }

  /** Set a field's touched bit. Used by the culling controls where the
   *  "— leave unchanged —" option must un-touch (a true no-op) rather than mark
   *  the field touched-and-cleared. */
  private _setTouched(field: keyof MixedValueMap, touched: boolean): void {
    this.touched.update((s) => {
      if (touched === s.has(field)) return s;
      const next = new Set(s);
      if (touched) next.add(field);
      else next.delete(field);
      return next;
    });
  }

  /** Rating input handler. Empty or non-(integer-0–5) input leaves rating
   *  UNTOUCHED so a transient NaN can't JSON-stringify to null and silently
   *  clear the rating; only a finite 0–5 integer is touched (0 = clear). */
  onRatingInput(raw: string): void {
    this.ratingVal.set(raw);
    const trimmed = raw.trim();
    const n = Number(trimmed);
    this._setTouched('rating', trimmed !== '' && Number.isInteger(n) && n >= 0 && n <= 5);
  }

  /** Flag select handler. '' = leave unchanged (no-op); `__clear__` = explicit
   *  clear (maps to `unflagged` in the payload); a real value is sent as-is. */
  onFlagChange(raw: string): void {
    this.flagVal.set(raw as 'pick' | 'reject' | 'unflagged' | '__clear__' | '');
    this._setTouched('flag', raw !== '');
  }

  /** Color-label select handler. '' = leave unchanged (no-op); `__clear__` =
   *  explicit clear (sends null); a color is sent as-is. */
  onColorLabelChange(raw: string): void {
    this.colorLabelVal.set(
      raw as 'red' | 'orange' | 'yellow' | 'green' | 'blue' | '__clear__' | '',
    );
    this._setTouched('colorLabel', raw !== '');
  }

  onReset(): void {
    this._resetToMixed();
  }

  // ── Geocode ───────────────────────────────────────────────────────────────

  onGeocodeQueryInput(value: string): void {
    this.geocodeQuery.set(value);
    if (value.trim().length < 2) {
      this.geocodeCandidates.set([]);
      this.geocodeLoading.set(false);
    }
  }

  onGeocodeSelect(candidate: GeocodeCandidate): void {
    this.gpsLatitudeVal.set(String(candidate.lat));
    this.gpsLongitudeVal.set(String(candidate.lon));
    this.onFieldChange('gpsLatitude');
    this.onFieldChange('gpsLongitude');

    // Populate structured place-text fields from the Nominatim address object.
    const addr = candidate.address;
    const city = addr['city'] ?? addr['town'] ?? addr['village'] ?? '';
    const state = addr['state'] ?? addr['region'] ?? '';
    const country = addr['country'] ?? '';
    const countryCode = (addr['country_code'] ?? '').toUpperCase();

    // Set all four unconditionally: when the chosen result lacks a city/state,
    // the empty value must CLEAR any previously-set place text rather than leave
    // a stale name mismatched against the new coordinates.
    this.cityVal.set(city);
    this.onFieldChange('city');
    this.stateVal.set(state);
    this.onFieldChange('state');
    this.countryVal.set(country);
    this.onFieldChange('country');
    this.countryCodeVal.set(countryCode);
    this.onFieldChange('countryCode');

    this.geocodeCandidates.set([]);
    this.geocodeQuery.set('');
  }

  // ── Submit flow ───────────────────────────────────────────────────────────

  onApply(): void {
    if (this.touched().size === 0) return;
    this.phase.set('confirm');
  }

  onConfirm(): void {
    this.phase.set('applying');
    // Clear any refile state from a previous run so a fresh apply can't flash a
    // stale error/count when it reaches the refile-offer phase.
    this.refileErrors.set([]);
    this.refileCount.set(0);
    const entries = this._buildPayload();
    this.svc.batchApply(entries).subscribe({
      next: (result) => {
        const failures = result.results.filter((r) => !r.ok);
        if (failures.length > 0) {
          this.applyErrors.set(
            failures.map((f) => ({ address: f.address, error: f.error ?? 'Unknown error' })),
          );
          // Stay on confirm phase showing errors.
          this.phase.set('confirm');
          return;
        }

        // Apply succeeded. Check whether we should offer a refile.
        const gpsTouched = this.touched().has('gpsLatitude') || this.touched().has('gpsLongitude');

        if (!gpsTouched) {
          this.phase.set('done');
          setTimeout(() => this.dismiss.emit(), 800);
          return;
        }

        // GPS was touched — ask the API how many backups would be relocated.
        const addresses = this.assetSnapshots().map((s) => s.address);
        this.refileSub?.unsubscribe();
        this.refileSub = this.svc.refileCount(addresses).subscribe({
          next: ({ count }) => {
            if (count > 0) {
              this.refileCount.set(count);
              this.phase.set('refile-offer');
            } else {
              this.phase.set('done');
              setTimeout(() => this.dismiss.emit(), 800);
            }
          },
          error: () => {
            // Count fetch failed — skip the offer and auto-dismiss.
            this.phase.set('done');
            setTimeout(() => this.dismiss.emit(), 800);
          },
        });
      },
      error: (err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Apply failed. Please try again.';
        this.errorMessage.set(msg);
        this.phase.set('error');
      },
    });
  }

  onConfirmCancel(): void {
    this.applyErrors.set([]);
    this.phase.set('form');
  }

  onClose(): void {
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    if (this.phase() !== 'applying' && this.phase() !== 'refile-applying') {
      this.dismiss.emit();
    }
  }

  // ── Refile-offer handlers ─────────────────────────────────────────────────

  /** User clicked "Move" — trigger the actual refile. */
  onRefileAccept(): void {
    this.phase.set('refile-applying');
    const addresses = this.assetSnapshots().map((s) => s.address);
    this.refileSub?.unsubscribe();
    this.refileSub = this.svc.refile(addresses).subscribe({
      next: (result) => {
        const failures = result.results.filter((r) => !r.ok);
        this.refileErrors.set(
          failures.map((f) => ({ address: f.address, error: f.error ?? 'Unknown error' })),
        );
        if (failures.length > 0) {
          // Return to the offer view to surface which copies failed, then dismiss.
          this.phase.set('refile-offer');
          setTimeout(() => this.dismiss.emit(), 2000);
        } else {
          // Full success — go straight to done; don't re-flash the offer prompt.
          this.phase.set('done');
          setTimeout(() => this.dismiss.emit(), 800);
        }
      },
      error: () => {
        // Refile failed — dismiss without retrying.
        this.dismiss.emit();
      },
    });
  }

  /** User clicked "Skip" — dismiss without refiling. */
  onRefileSkip(): void {
    this.dismiss.emit();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Build the POST /api/xmp/batch payload from only touched fields. */
  private _buildPayload(): BatchApplyEntry[] {
    const t = this.touched();
    const meta: BatchApplyMetadata = {};

    if (t.has('gpsLatitude')) {
      const v = this.gpsLatitudeVal().trim();
      meta.gpsLatitude = v === '' ? null : Number(v);
    }
    if (t.has('gpsLongitude')) {
      const v = this.gpsLongitudeVal().trim();
      meta.gpsLongitude = v === '' ? null : Number(v);
    }
    if (t.has('gpsAltitude')) {
      const v = this.gpsAltitudeVal().trim();
      meta.gpsAltitude = v === '' ? null : Number(v);
    }
    if (t.has('dateTimeOriginal')) {
      const v = this.dateTimeOriginalVal().trim();
      meta.dateTimeOriginal = v === '' ? null : v;
    }
    if (t.has('timeZone')) {
      const v = this.timeZoneVal().trim();
      meta.timeZone = v === '' ? null : v;
    }
    if (t.has('sublocation')) {
      const v = this.sublocationVal().trim();
      meta.sublocation = v === '' ? null : v;
    }
    if (t.has('city')) {
      const v = this.cityVal().trim();
      meta.city = v === '' ? null : v;
    }
    if (t.has('state')) {
      const v = this.stateVal().trim();
      meta.state = v === '' ? null : v;
    }
    if (t.has('country')) {
      const v = this.countryVal().trim();
      meta.country = v === '' ? null : v;
    }
    if (t.has('countryCode')) {
      const v = this.countryCodeVal().trim();
      meta.countryCode = v === '' ? null : v;
    }
    if (t.has('title')) {
      const v = this.titleVal().trim();
      meta.title = v === '' ? null : v;
    }
    if (t.has('caption')) {
      const v = this.captionVal().trim();
      meta.caption = v === '' ? null : v;
    }
    if (t.has('headline')) {
      const v = this.headlineVal().trim();
      meta.headline = v === '' ? null : v;
    }
    if (t.has('keywords')) {
      const v = this.keywordsVal().trim();
      meta.keywords =
        v === ''
          ? []
          : v
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean);
    }
    if (t.has('instructions')) {
      const v = this.instructionsVal().trim();
      meta.instructions = v === '' ? null : v;
    }
    if (t.has('creator')) {
      const v = this.creatorVal().trim();
      meta.creator = v === '' ? null : v;
    }
    if (t.has('creatorJobTitle')) {
      const v = this.creatorJobTitleVal().trim();
      meta.creatorJobTitle = v === '' ? null : v;
    }
    if (t.has('copyrightNotice')) {
      const v = this.copyrightNoticeVal().trim();
      meta.copyrightNotice = v === '' ? null : v;
    }
    if (t.has('copyrightStatus')) {
      const v = this.copyrightStatusVal();
      meta.copyrightStatus = v === '' ? null : (v as CopyrightStatus);
    }
    if (t.has('usageTerms')) {
      const v = this.usageTermsVal().trim();
      meta.usageTerms = v === '' ? null : v;
    }
    if (t.has('credit')) {
      const v = this.creditVal().trim();
      meta.credit = v === '' ? null : v;
    }
    if (t.has('source')) {
      const v = this.sourceVal().trim();
      meta.source = v === '' ? null : v;
    }
    if (t.has('rating')) {
      // The rating handler only marks this touched for a finite 0–5 integer, so
      // Number() is safe here (no NaN→null surprise).
      meta.rating = Number(this.ratingVal().trim());
    }
    if (t.has('flag')) {
      // Touched only via a non-empty option. The explicit-clear sentinel maps to
      // 'unflagged'; '' (leave unchanged) can never reach here.
      const v = this.flagVal();
      meta.flag = v === '__clear__' ? 'unflagged' : (v as 'pick' | 'reject' | 'unflagged');
    }
    if (t.has('colorLabel')) {
      // Touched only via a non-empty option. The explicit-clear sentinel sends
      // null; '' (leave unchanged) can never reach here.
      const v = this.colorLabelVal();
      meta.colorLabel =
        v === '__clear__' ? null : (v as 'red' | 'orange' | 'yellow' | 'green' | 'blue');
    }

    return this.assetSnapshots().map((snap) => ({ address: snap.address, metadata: meta }));
  }

  /** Reset all field signals to their mixed/original values. */
  private _resetToMixed(): void {
    const m = this.mixed();
    this.phase.set('form');
    this.touched.set(new Set());
    this.applyErrors.set([]);
    this.errorMessage.set('');
    this.geocodeCandidates.set([]);
    this.geocodeQuery.set('');

    // Helper: convert a mixed-or-value to a display string.
    const str = (v: unknown): string => {
      if (v === MIXED || v == null || v === undefined) return '';
      if (Array.isArray(v)) return v.join(', ');
      return String(v);
    };

    this.gpsLatitudeVal.set(str(m.gpsLatitude));
    this.gpsLongitudeVal.set(str(m.gpsLongitude));
    this.gpsAltitudeVal.set(str(m.gpsAltitude));
    this.dateTimeOriginalVal.set(str(m.dateTimeOriginal));
    this.timeZoneVal.set(str(m.timeZone));
    this.sublocationVal.set(str(m.sublocation));
    this.cityVal.set(str(m.city));
    this.stateVal.set(str(m.state));
    this.countryVal.set(str(m.country));
    this.countryCodeVal.set(str(m.countryCode));
    this.titleVal.set(str(m.title));
    this.captionVal.set(str(m.caption));
    this.headlineVal.set(str(m.headline));
    this.keywordsVal.set(str(m.keywords));
    this.instructionsVal.set(str(m.instructions));
    this.creatorVal.set(str(m.creator));
    this.creatorJobTitleVal.set(str(m.creatorJobTitle));
    this.copyrightNoticeVal.set(str(m.copyrightNotice));
    this.copyrightStatusVal.set(
      m.copyrightStatus === MIXED || m.copyrightStatus == null ? '' : m.copyrightStatus,
    );
    this.usageTermsVal.set(str(m.usageTerms));
    this.creditVal.set(str(m.credit));
    this.sourceVal.set(str(m.source));
    this.ratingVal.set(m.rating === MIXED || m.rating == null ? '' : String(m.rating));
    this.flagVal.set(
      m.flag === MIXED || m.flag == null ? '' : (m.flag as 'pick' | 'reject' | 'unflagged'),
    );
    this.colorLabelVal.set(
      m.colorLabel === MIXED || m.colorLabel == null
        ? ''
        : (m.colorLabel as 'red' | 'orange' | 'yellow' | 'green' | 'blue'),
    );
  }
}
