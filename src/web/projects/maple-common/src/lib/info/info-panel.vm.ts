// InfoPanelComponent — pure view-model module.
//
// Co-located with `info-panel.component.ts` per the `*.vm.ts` pattern
// (#190). Everything here is plain TypeScript projecting an `Asset` (or raw
// histogram bins) into the shapes the mui-ui molecules `<mui-label-value-grid>`,
// `<mui-keyword-row>`, and `<mui-rating-flags>` accept — no `@angular/*`
// imports, no DI, no signals. `InfoPanelComponent` owns the signal wiring
// and the live-canvas / server-fallback histogram fetch (real side effects
// that don't belong in a pure module).
//
// Absorbed the former `camera-location-grid.component.ts` (`rowsFor`),
// `keyword-chips-row.component.ts` (keyword→chip projection), and
// `rating-flags-row.component.ts` (Flag↔MuiRatingFlagState mapping) — all
// three were pure projections wrapped in a component whose entire template
// was hand-rolled markup a mui molecule now renders instead.

import type { Asset, Flag } from '../models/asset';
import type { MuiChip } from '../ui/chip-row/mui-chip-row.component';
import type { MuiLabelValueRow } from '../ui/label-value-grid/mui-label-value-grid.component';
import type { MuiRatingFlagState } from '../ui/rating-flags/mui-rating-flags.component';

/** 2-column EXIF / GPS key-value grid backing `<mui-label-value-grid>`.
 * Missing fields render as "—" so the row count is constant regardless of
 * the image. Mirrors the retired `CameraLocationGridComponent.rowsFor`. */
export function cameraLocationRows(a: Asset | null): MuiLabelValueRow[] {
  return [
    { label: 'Body', value: a?.camera ?? '—' },
    { label: 'Lens', value: a?.lens ?? '—' },
    { label: 'Aperture', value: a?.aperture ?? '—' },
    { label: 'Shutter', value: a?.shutter ?? '—' },
    { label: 'ISO', value: a?.iso !== undefined ? String(a.iso) : '—' },
    { label: 'Focal', value: a?.focalLength ?? '—' },
    {
      label: 'Coords',
      value: a?.gps ? `${a.gps.lat.toFixed(4)}, ${a.gps.lon.toFixed(4)}` : '—',
    },
    { label: 'City', value: a?.city ?? '—' },
  ];
}

/** `asset.keywords` projected to `<mui-keyword-row>`'s chip shape. Keywords
 * are plain unique strings server-side, so the string itself doubles as the
 * chip id — `removed`/`added` events round-trip the same string back. */
export function keywordChips(a: Asset | null): readonly MuiChip[] {
  return (a?.keywords ?? []).map((k) => ({ id: k, label: k }));
}

/** `Flag` (`'unflagged' | 'pick' | 'reject'`, the Asset model's vocabulary)
 * to `MuiRatingFlagState` (`'none' | 'pick' | 'reject'`, the mui vocabulary)
 * — same three states, different spelling for "neither". */
export function toMuiFlagState(flag: Flag): MuiRatingFlagState {
  return flag === 'unflagged' ? 'none' : flag;
}

/** Inverse of {@link toMuiFlagState}. */
export function fromMuiFlagState(state: MuiRatingFlagState): Flag {
  return state === 'none' ? 'unflagged' : state;
}

/** `Uint32Array` bins (the live-canvas path's native output) to the plain
 * `number[]` `<mui-histogram>` requires. The server-fallback path already
 * returns `number[]` and needs no conversion. */
export function toHistogramBins(bins: ArrayLike<number>): number[] {
  return Array.from(bins);
}
