/**
 * Pure option mapping for the v2 raster C ABI: the small functions the fluent
 * builder uses to turn its accumulated state into the flat arguments the FFI
 * takes. Split out of `builder.ts` to keep that file inside the repo's
 * file-size budget — see `raw-pipeline/raw-ffi/src/raster_v2.rs` for the ABI.
 */
import type { ExportFormat } from './types';
/** Infer the output container format from a file path's extension, defaulting to JPEG. */
export declare function formatForPath(outputPath: string): ExportFormat;
/**
 * Bitmask for the v2 raster entry points: bit0 fill, bit1 auto-orient,
 * bit2 allow enlargement, bit3 cover (wins over fill).
 */
export declare function resizeFlags(opts: {
    fit: 'inside' | 'fill' | 'cover';
    autoOrient: boolean;
    withoutEnlargement: boolean;
}): number;
/**
 * AVIF effort as the C ABI wants it: one-based, with `0` reserved for
 * "unset". That reservation is what makes sharp's `effort: 0` (fastest)
 * expressible at all — it goes over the wire as `1`, while an untouched
 * builder sends `0` and the encoder picks its own default. Rust maps wire
 * `n` to rav1e speed `11 - n`.
 */
export declare function avifEffortWire(effort: number | null): number;
