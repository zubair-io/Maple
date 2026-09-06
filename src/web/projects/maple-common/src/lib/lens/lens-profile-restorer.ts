import { lensProfileDigest } from './lens-profile-cache';

/** One decode worker's selection memo and verified process-cache inventory. */
export class LensProfileRestorer {
  private previousXmp: string | null = null;
  private previousReference = '';
  private readonly loaded = new Set<string>();

  constructor(
    private readonly select: (xmp: string) => Promise<string>,
    private readonly restoreCached: (reference: string, digest: string) => Promise<boolean>,
  ) {}

  registered(reference: string): void {
    this.loaded.add(lensProfileDigest(reference));
  }

  /** Scalar GPU ticks carry no XMP. Unusual XML forms are delegated to the core;
   * ordinary sidecars without a LensProfile local name need no extra parse. */
  async restore(xmp: string | null): Promise<void> {
    if (!xmp || !/\bLensProfile\b/.test(xmp)) return;
    if (this.previousXmp !== xmp) {
      this.previousReference = await this.select(xmp);
      this.previousXmp = xmp;
    }
    const reference = this.previousReference;
    if (!reference) return;
    const digest = lensProfileDigest(reference);
    if (this.loaded.has(digest)) return;
    try {
      if (await this.restoreCached(reference, digest)) this.registered(reference);
    } catch {
      // Unavailable/corrupt storage cannot block an embedded or disabled
      // correction. Core still fails explicitly when this LCP is required.
    }
  }
}
