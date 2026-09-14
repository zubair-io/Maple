/**
 * Native bindings loader for Maple via bun:ffi.
 */
import type { RasterAnalyzeBinding } from './native-raster-analyze';
import type { RasterPipelineBinding } from './native-raster-pipeline';
import type { RasterV2Binding } from './native-raster-v2';
import type { FilenameResult, FilenameTemplateArgs } from './types';
export interface NativeBinding extends RasterV2Binding, RasterPipelineBinding, RasterAnalyzeBinding {
    exportDevelopedToFile(rawPath: string, xmpPath: string | null, format: string, quality: number, colorSpace: string, maxLongEdge: number, outPath: string): {
        ok: boolean;
        error?: string;
    };
    exportRecipeToFile(rawPath: string, xmpXml: string, recipeJson: string, filmPath: string | null, outPath: string): {
        ok: boolean;
        error?: string;
    };
    renderThumbnailAvifToFile(rawPath: string, outPath: string, maxPx: number, quality?: number): {
        ok: boolean;
        error?: string;
    };
    renderThumbnailPreviewJpegToFile(rawPath: string, outPath: string, maxPx: number, quality?: number): {
        ok: boolean;
        error?: string;
    };
    renderDevelopJpegToFile(rawPath: string, xmpPath: string | null, outPath: string, maxPx: number, quality?: number): {
        ok: boolean;
        error?: string;
    };
    rasterResizeToFile(inputPath: string, outPath: string, width: number, height: number, fit: number, format: string | null, quality: number): {
        ok: boolean;
        error?: string;
    };
    rasterResizeToBuf(inputBytes: Uint8Array, width: number, height: number, fit: number, format: string | null, quality: number): {
        ok: boolean;
        buffer?: Buffer;
        error?: string;
    };
    rasterProbeMetadata(inputPath: string): {
        ok: boolean;
        metadata?: {
            width: number;
            height: number;
            channels: number;
            orientation: number;
            format?: string;
        };
        error?: string;
    };
    rasterProbeMetadataBuf(inputBytes: Uint8Array): {
        ok: boolean;
        metadata?: {
            width: number;
            height: number;
            channels: number;
            orientation: number;
            format: string;
        };
        error?: string;
    };
    rasterExtractTensor(inputBytes: Uint8Array, targetSize: number, layout: number, normalize: number): {
        ok: boolean;
        tensor?: Float32Array;
        error?: string;
    };
    renderFilenameTemplate(args: FilenameTemplateArgs): FilenameResult;
    validateFilename(name: string): {
        ok: true;
    } | {
        ok: false;
        code: number;
        error: string;
    };
    lastError(): string | null;
}
/** Find the platform-specific library name */
export declare function nativeLibFilename(): string;
/**
 * Locate the native shared library.
 *
 * Order: the explicit `MAPLE_NATIVE_LIB` override, then a binary built from
 * this checkout, then the installed `@justmaple/maple-<platform>` package,
 * then generic runtime locations. The source-built paths point at sibling
 * crates/packages that only exist inside the monorepo (an installed npm
 * package never has them), so they are an explicit "use what `cargo build`
 * just produced" selection, not a search of arbitrary local files — a local
 * pipeline change is what `bun test` and the API exercise, never a stale
 * prebuilt pulled in by `bun install`.
 */
export declare function findNativeLib(): string | null;
export declare function loadNativeBinding(): NativeBinding;
/**
 * Render one filename from a batch-rename template.
 *
 * Prefers the napi addon (#3509) when one is resolvable — both
 * `renderFilenameTemplate` and `validateFilename` are synchronous, no-I/O
 * napi exports (see `native-napi.ts`'s module doc), so this stays a plain
 * synchronous call on every platform: no signature change, no Promise, on
 * Node or Bun alike. Only falls back to `loadNativeBinding()` (bun:ffi,
 * Bun-only) when no napi addon is available, matching `callNative`'s own
 * dispatch order in `worker-pool.ts`. Without this, these two public,
 * documented (`README.md`) top-level exports would throw on plain Node even
 * when a napi addon IS resolvable, since `loadNativeBinding()` requires Bun
 * unconditionally — confirmed empirically while proving Node support for
 * #3509's own acceptance test.
 */
export declare function renderFilenameTemplate(args: FilenameTemplateArgs): FilenameResult;
/**
 * Validate a filename against standard file system naming rules.
 *
 * See `renderFilenameTemplate` above for why this prefers the napi addon
 * first, synchronously, before falling back to bun:ffi.
 */
export declare function validateFilename(name: string): {
    ok: true;
} | {
    ok: false;
    code: number;
    error: string;
};
/**
 * Check if the native library is available on disk.
 */
export declare function isNativeAvailable(): boolean;
