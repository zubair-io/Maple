// One render worker's memory of which imported profiles its raw-core process
// cache holds (#3479). Every request that carries a sidecar runs through
// `restore` before it is dispatched, so a profile the sidecar names is
// registered before the decode that needs it — or reported as unavailable
// so the panel can say so instead of the image silently rendering without
// its correction (raw-core refuses that render on its own).

import { lensProfileDigest } from './lens-profile-cache';

export interface LensProfileRestoreOutcome {
  reference: string;
  available: boolean;
  message?: string;
}

export const LENS_PROFILE_MISSING_MESSAGE =
  'The selected lens profile is not in this browser or the server cache. Import the original .lcp file to restore it.';

export class LensProfileRestorer {
  private previousXmp: string | null = null;
  private previousReference = '';
  /** Digests registered in the process cache since the last `reset`. */
  private readonly loaded = new Set<string>();
  /** Digests no cache could supply; forgotten on the next import or reset. */
  private readonly missing = new Set<string>();

  constructor(
    private readonly select: (xmp: string) => Promise<string>,
    private readonly restoreCached: (reference: string, digest: string) => Promise<boolean>,
  ) {}

  /** A profile registered by an import or a completed restore. */
  registered(reference: string): void {
    const digest = lensProfileDigest(reference);
    this.loaded.add(digest);
    this.missing.delete(digest);
  }

  /** The process cache was cleared: every profile needs registering again. */
  reset(): void {
    this.loaded.clear();
    this.missing.clear();
  }

  /**
   * Make sure the profile `xmp` selects is registered. Resolves `null` when
   * there is nothing to do: no sidecar (scalar GPU ticks carry none), no
   * selection, corrections disabled, or the profile already registered /
   * already known missing. Ordinary sidecars without a LensProfile local
   * name never reach the parser; unusual XML forms are delegated to it.
   */
  async restore(xmp: string | null): Promise<LensProfileRestoreOutcome | null> {
    if (!xmp || !/\bLensProfile\b/.test(xmp)) return null;
    if (this.previousXmp !== xmp) {
      this.previousReference = await this.select(xmp);
      this.previousXmp = xmp;
    }
    const reference = this.previousReference;
    if (!reference) return null;
    try {
      const digest = lensProfileDigest(reference);
      if (this.loaded.has(digest) || this.missing.has(digest)) return null;
      if (await this.restoreCached(reference, digest)) {
        this.loaded.add(digest);
        return { reference, available: true };
      }
      this.missing.add(digest);
      return { reference, available: false, message: LENS_PROFILE_MISSING_MESSAGE };
    } catch (error) {
      // Denied storage, a corrupt row or an unsupported reference version:
      // the render decides whether the profile was required and fails
      // explicitly if so; the panel shows this message either way.
      return {
        reference,
        available: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
