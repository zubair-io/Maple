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
  /** Parse `file`'s EXIF, restricted to `pick`. Returns `undefined` when
   * `exifr` finds nothing (matches `exifr.parse`'s own contract) or throws
   * on an unparseable/corrupt file — the caller decides what "no EXIF"
   * means for its use case. */
  async parse(file: File, pick: readonly string[]): Promise<Record<string, unknown> | undefined> {
    return resolveExifr().parse(file, { pick: [...pick] }) as Promise<
      Record<string, unknown> | undefined
    >;
  }
}
