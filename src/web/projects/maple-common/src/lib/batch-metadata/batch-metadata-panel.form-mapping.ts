// batch-metadata-panel.form-mapping.ts — pure field-mapping logic extracted
// from BatchMetadataPanelComponent so that file stays under the 600-LOC
// budget. No Angular, no signals — a plain snapshot-in, payload-out function,
// testable standalone (mirrors the `computeMixedValues` pattern in
// batch-metadata.types.ts).

import type { BatchApplyMetadata, MixedValueMap } from './batch-metadata.types';
import type { CopyrightStatus } from '../xmp/xmp.types';

/** Flat string snapshot of every per-field form-control signal on the panel,
 * at the moment `onConfirm`/`_buildPayload` runs. Mirrors each `xVal()`
 * signal's current value 1:1. */
export interface BatchMetadataFormValues {
  gpsLatitude: string;
  gpsLongitude: string;
  gpsAltitude: string;
  dateTimeOriginal: string;
  timeZone: string;
  sublocation: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
  title: string;
  caption: string;
  headline: string;
  keywords: string;
  instructions: string;
  creator: string;
  creatorJobTitle: string;
  copyrightNotice: string;
  copyrightStatus: CopyrightStatus | '';
  usageTerms: string;
  credit: string;
  source: string;
  rating: string;
  flag: 'pick' | 'reject' | 'unflagged' | '__clear__' | '';
  colorLabel: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | '__clear__' | '';
  hidden: 'true' | 'false' | '__clear__' | '';
}

/** Build the POST /api/xmp/batch metadata payload from only the touched
 * fields. Extracted verbatim from `BatchMetadataPanelComponent._buildPayload`
 * — same per-field semantics (empty string clears, `__clear__` sentinel
 * clears the select-driven culling fields, `rating`'s `onRatingInput` handler
 * guarantees a touched rating is always a finite 0–5 integer). */
export function buildBatchApplyMetadata(
  touched: ReadonlySet<keyof MixedValueMap>,
  v: BatchMetadataFormValues,
): BatchApplyMetadata {
  const meta: BatchApplyMetadata = {};

  if (touched.has('gpsLatitude')) {
    meta.gpsLatitude = v.gpsLatitude.trim() === '' ? null : Number(v.gpsLatitude);
  }
  if (touched.has('gpsLongitude')) {
    meta.gpsLongitude = v.gpsLongitude.trim() === '' ? null : Number(v.gpsLongitude);
  }
  if (touched.has('gpsAltitude')) {
    meta.gpsAltitude = v.gpsAltitude.trim() === '' ? null : Number(v.gpsAltitude);
  }
  if (touched.has('dateTimeOriginal')) {
    meta.dateTimeOriginal = v.dateTimeOriginal.trim() === '' ? null : v.dateTimeOriginal.trim();
  }
  if (touched.has('timeZone')) {
    meta.timeZone = v.timeZone.trim() === '' ? null : v.timeZone.trim();
  }
  if (touched.has('sublocation')) {
    meta.sublocation = v.sublocation.trim() === '' ? null : v.sublocation.trim();
  }
  if (touched.has('city')) {
    meta.city = v.city.trim() === '' ? null : v.city.trim();
  }
  if (touched.has('state')) {
    meta.state = v.state.trim() === '' ? null : v.state.trim();
  }
  if (touched.has('country')) {
    meta.country = v.country.trim() === '' ? null : v.country.trim();
  }
  if (touched.has('countryCode')) {
    meta.countryCode = v.countryCode.trim() === '' ? null : v.countryCode.trim();
  }
  if (touched.has('title')) {
    meta.title = v.title.trim() === '' ? null : v.title.trim();
  }
  if (touched.has('caption')) {
    meta.caption = v.caption.trim() === '' ? null : v.caption.trim();
  }
  if (touched.has('headline')) {
    meta.headline = v.headline.trim() === '' ? null : v.headline.trim();
  }
  if (touched.has('keywords')) {
    const kw = v.keywords.trim();
    meta.keywords =
      kw === ''
        ? []
        : kw
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
  }
  if (touched.has('instructions')) {
    meta.instructions = v.instructions.trim() === '' ? null : v.instructions.trim();
  }
  if (touched.has('creator')) {
    meta.creator = v.creator.trim() === '' ? null : v.creator.trim();
  }
  if (touched.has('creatorJobTitle')) {
    meta.creatorJobTitle = v.creatorJobTitle.trim() === '' ? null : v.creatorJobTitle.trim();
  }
  if (touched.has('copyrightNotice')) {
    meta.copyrightNotice = v.copyrightNotice.trim() === '' ? null : v.copyrightNotice.trim();
  }
  if (touched.has('copyrightStatus')) {
    meta.copyrightStatus = v.copyrightStatus === '' ? null : v.copyrightStatus;
  }
  if (touched.has('usageTerms')) {
    meta.usageTerms = v.usageTerms.trim() === '' ? null : v.usageTerms.trim();
  }
  if (touched.has('credit')) {
    meta.credit = v.credit.trim() === '' ? null : v.credit.trim();
  }
  if (touched.has('source')) {
    meta.source = v.source.trim() === '' ? null : v.source.trim();
  }
  if (touched.has('rating')) {
    // onRatingInput only marks this touched for a finite 0–5 integer, so
    // Number() is safe here (no NaN→null surprise).
    meta.rating = Number(v.rating.trim());
  }
  if (touched.has('flag')) {
    // Touched only via a non-empty option. The explicit-clear sentinel maps
    // to 'unflagged'; '' (leave unchanged) can never reach here — the cast
    // documents that invariant since the ternary alone can't narrow it away.
    meta.flag = v.flag === '__clear__' ? 'unflagged' : (v.flag as 'pick' | 'reject' | 'unflagged');
  }
  if (touched.has('colorLabel')) {
    // Touched only via a non-empty option. The explicit-clear sentinel sends
    // null; '' (leave unchanged) can never reach here — same cast rationale
    // as `flag` above.
    meta.colorLabel =
      v.colorLabel === '__clear__'
        ? null
        : (v.colorLabel as 'red' | 'orange' | 'yellow' | 'green' | 'blue');
  }
  if (touched.has('hidden')) {
    meta.hidden = v.hidden === '__clear__' ? null : v.hidden === 'true';
  }

  return meta;
}
