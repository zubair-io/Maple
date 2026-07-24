// ExifReaderService — thin injectable wrapper around `exifr.parse` (#1995).
//
// Exists so `HostedMapleIdService` can depend on this via Angular DI and get
// swapped for a fake via `TestBed`'s `useValue` provider override — the same
// pattern already used for `MapleIdFallbackHasherService`/`MapleIdCacheService`
// in that file, and the one class of dependency substitution proven stable in
// this codebase's test suite.
//
// Deliberately NOT a bare module-level function wrapping `exifr.parse`: that
// shape depends on `vi.mock('exifr', ...)` correctly intercepting the
// package's own module resolution, which `exifr` (no `"exports"` map — only
// legacy `main`/`module` fields) makes ambiguous for Vitest's SSR
// inline-vs-external dependency handling. That ambiguity reproduced as a
// real, intermittent CI failure — `exifr.parse` silently resolving to the
// unmocked real implementation instead of a test's mock, only at large
// module-graph sizes, surviving three independent module-level mitigations
// (a namespace-import interop fix, lazy per-call resolution instead of
// module-load-time, and forcing the package to Vitest's `deps.inline` list).
// Routing through Angular's DI instead sidesteps `vi.mock()`'s package-level
// interception entirely — no ambiguity for a test to race against.
import { Injectable } from '@angular/core';
import * as exifrNs from 'exifr';

/** Resolves whichever shape `exifr`'s CJS/UMD-legacy default export ends up
 * as under the current bundler/runtime — see this file's module doc. */
function resolveExifr(): typeof exifrNs {
  return (exifrNs as unknown as { default?: typeof exifrNs }).default ?? exifrNs;
}

@Injectable({ providedIn: 'root' })
export class ExifReaderService {
  /**
   * Parse `file`'s EXIF, restricted to `pick`. Returns `undefined` when
   * `exifr` finds nothing (matches `exifr.parse`'s own contract) or throws
   * on an unparseable/corrupt file — the caller decides what "no EXIF"
   * means for its use case.
   *
   * [P0-2, caught in review]: `reviveValues: false` is required here, not
   * cosmetic. exifr's *default* (`reviveValues: true`) converts
   * DateTimeOriginal/CreateDate from their raw "YYYY:MM:DD HH:MM:SS" string
   * into a `Date` object itself, via a 3-argument `new Date(y, m-1, d)` +
   * local `setHours`/`setMinutes`/`setSeconds` (confirmed directly in
   * exifr's own bundled source, the `ze` function) — i.e. exifr's *own*
   * Date construction is exactly the same LOCAL-timezone-ambiguous pattern
   * `captured-at.ts`'s `asIsoDate` was fixed to stop doing.
   *
   * `asIsoDate`'s `Date` branch is now (#2154) also fixed to read those same
   * local calendar fields back out, which correctly un-biases exactly this
   * kind of locally-constructed `Date` — so a revived `Date` reaching it
   * would no longer misformat. `reviveValues: false` stays anyway: it keeps
   * this service's output on the plain "raw EXIF string" code path (the one
   * actually fixed to use `Date.UTC(...)`), rather than leaning on the
   * newer, more narrowly-scoped contract that a `Date` reaching `asIsoDate`
   * always encodes a timezone-naive wall clock via local fields. Since this
   * service only ever picks DateTimeOriginal/CreateDate (no GPS, no other
   * revived tags), disabling revival globally for this call has no other
   * side effects to worry about.
   */
  async parse(file: File, pick: readonly string[]): Promise<Record<string, unknown> | undefined> {
    return resolveExifr().parse(file, { pick: [...pick], reviveValues: false }) as Promise<
      Record<string, unknown> | undefined
    >;
  }
}
