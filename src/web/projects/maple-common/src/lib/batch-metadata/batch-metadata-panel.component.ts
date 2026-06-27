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
import { Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, filter, switchMap } from 'rxjs/operators';
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
import type { XmpFlag, XmpColorLabel, CopyrightStatus } from '../xmp/xmp.types';

type PanelPhase = 'form' | 'confirm' | 'applying' | 'done' | 'error';

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
  readonly flagVal = signal<XmpFlag | ''>('');
  readonly colorLabelVal = signal<XmpColorLabel | ''>('');

  // ── Per-field touched flags ────────────────────────────────────────────────
  readonly touched = signal<Set<keyof MixedValueMap>>(new Set());

  // ── Geocode state ─────────────────────────────────────────────────────────
  readonly geocodeQuery = signal<string>('');
  readonly geocodeCandidates = signal<GeocodeCandidate[]>([]);
  readonly geocodeLoading = signal<boolean>(false);

  // ── Apply errors ──────────────────────────────────────────────────────────
  readonly applyErrors = signal<Array<{ path: string; error: string }>>([]);
  readonly errorMessage = signal<string>('');

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

  // ── MIXED sentinel exposed to the template ─────────────────────────────────
  readonly MIXED = MIXED;

  // ── Geocode subscription ───────────────────────────────────────────────────
  private readonly geocodeSub: Subscription;

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
        filter((q) => q.trim().length >= 2),
        switchMap((q) => {
          this.geocodeLoading.set(true);
          return this.svc.geocodeSearch(q.trim());
        }),
      )
      .subscribe({
        next: (candidates) => {
          this.geocodeLoading.set(false);
          this.geocodeCandidates.set(candidates);
        },
        error: () => {
          this.geocodeLoading.set(false);
          this.geocodeCandidates.set([]);
        },
      });
  }

  ngOnDestroy(): void {
    this.geocodeSub.unsubscribe();
  }

  // ── Field change handlers ─────────────────────────────────────────────────

  onFieldChange(field: keyof MixedValueMap): void {
    this.touched.update((s) => {
      const next = new Set(s);
      next.add(field);
      return next;
    });
  }

  onReset(): void {
    this._resetToMixed();
  }

  // ── Geocode ───────────────────────────────────────────────────────────────

  onGeocodeQueryInput(value: string): void {
    this.geocodeQuery.set(value);
    if (value.trim().length < 2) {
      this.geocodeCandidates.set([]);
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

    if (city) {
      this.cityVal.set(city);
      this.onFieldChange('city');
    }
    if (state) {
      this.stateVal.set(state);
      this.onFieldChange('state');
    }
    if (country) {
      this.countryVal.set(country);
      this.onFieldChange('country');
    }
    if (countryCode) {
      this.countryCodeVal.set(countryCode);
      this.onFieldChange('countryCode');
    }

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
    const entries = this._buildPayload();
    this.svc.batchApply(entries).subscribe({
      next: (result) => {
        const failures = result.results.filter((r) => !r.ok);
        if (failures.length > 0) {
          this.applyErrors.set(
            failures.map((f) => ({ path: f.path, error: f.error ?? 'Unknown error' })),
          );
          // Stay on confirm phase showing errors.
          this.phase.set('confirm');
        } else {
          this.phase.set('done');
          // Auto-dismiss after a brief moment.
          setTimeout(() => this.dismiss.emit(), 800);
        }
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
    if (this.phase() !== 'applying') {
      this.dismiss.emit();
    }
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
      const v = this.ratingVal();
      meta.rating = v === '' ? undefined : Number(v);
    }
    if (t.has('flag')) {
      const v = this.flagVal();
      meta.flag = v === '' ? undefined : (v as XmpFlag);
    }
    if (t.has('colorLabel')) {
      const v = this.colorLabelVal();
      meta.colorLabel = v === '' ? undefined : (v as XmpColorLabel);
    }

    return this.assetSnapshots().map((snap) => ({ path: snap.path, metadata: meta }));
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
    this.ratingVal.set(str(m.rating));
    this.flagVal.set(m.flag === MIXED || m.flag == null ? '' : m.flag);
    this.colorLabelVal.set(m.colorLabel === MIXED || m.colorLabel == null ? '' : m.colorLabel);
  }
}
