/**
 * Types for the Maple image processing package.
 */
export type ExportFormat = 'jpeg' | 'tiff' | 'png' | 'avif' | 'webp';
export type ExportColorSpace = 'srgb' | 'display-p3';
export interface ImageMetadata {
    width: number;
    height: number;
    format: string;
    channels: number;
    orientation: number;
    isRaw?: boolean;
}
/** sharp's `position` spellings, on top of the nine gravity names. */
export type ResizePosition = 'centre' | 'center' | 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest' | 'top' | 'right top' | 'right' | 'right bottom' | 'bottom' | 'left bottom' | 'left' | 'left top';
export type ResizeKernel = 'nearest' | 'linear' | 'bilinear' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3';
export interface ResizeOptions {
    width?: number | null;
    height?: number | null;
    fit?: 'inside' | 'fill' | 'cover' | 'contain' | 'outside';
    /** Where the source sits inside the target box for `cover` and `contain`. Alias: `gravity`. */
    position?: ResizePosition;
    gravity?: ResizePosition;
    /** Letterbox colour for `fit: 'contain'`. */
    background?: Colour | string;
    /** sharp's name for the resampling kernel. */
    kernel?: ResizeKernel;
    /** Maple's Tier 1 name for the same option. `kernel` wins when both are set. */
    filter?: ResizeKernel;
    /** NOTE: defaults to `true` here, where sharp defaults it to `false`. */
    withoutEnlargement?: boolean;
    withoutReduction?: boolean;
}
export interface RawPixelInput {
    data: Uint8Array;
    width: number;
    height: number;
    channels: 1 | 3 | 4;
}
export interface RawPixels {
    data: Uint8Array;
    width: number;
    height: number;
    channels: 3;
}
/** Native-size pixels with whatever channel count the source carried. */
export interface RawPixelsAny {
    data: Uint8Array;
    width: number;
    height: number;
    channels: 3 | 4;
}
/** `{ r, g, b, alpha }`, each 0-255 for r/g/b and 0-1 for alpha. */
export type Colour = {
    r: number;
    g: number;
    b: number;
    alpha?: number;
};
export interface CompositeLayer {
    /** Encoded image bytes, or a raw pixel buffer. */
    input: Uint8Array | Buffer | RawPixelInput;
    left?: number;
    top?: number;
    gravity?: 'centre' | 'center' | 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest';
    blend?: 'over' | 'multiply' | 'screen' | 'add' | 'darken' | 'lighten' | 'dest-in' | 'dest-out';
    tile?: boolean;
}
export interface EncodeOptions {
    quality?: number;
    /** AVIF only: 0 (fastest) … 9 (slowest), sharp's scale. */
    effort?: number;
}
export interface ExtractRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}
export interface ExtendOptions {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    /** Only `'background'` is implemented; anything else throws by name. */
    extendWith?: 'background';
    background?: Colour | string;
}
export interface RotateOptions {
    background?: Colour | string;
}
export interface TrimOptions {
    /** Defaults to the colour of the top-left pixel, as in sharp. */
    background?: Colour | string;
    threshold?: number;
    margin?: number;
    /**
     * sharp's line-art trim mode is not implemented (#3501). The type only
     * accepts `false` (its default); passing `true` throws by name at
     * execution rather than being silently ignored.
     */
    lineArt?: false;
}
export interface TensorOptions {
    targetSize?: number;
    layout?: 'nchw' | 'hwc';
    normalize?: 'none' | 'insightface' | 'zeroToOne';
}
export interface TensorResult {
    data: Float32Array;
    width: number;
    height: number;
    channels: number;
}
export interface ExportImageOptions {
    /** Path to source RAW file */
    rawPath: string;
    /** Path to output file */
    outPath: string;
    /** Optional path to XMP sidecar containing adjustments */
    xmpPath?: string | null;
    /** Export container format. Default 'jpeg' */
    format?: ExportFormat;
    /** Quality 1..100 (for lossy JPEG). Default 92 */
    quality?: number;
    /** Output color primaries and ICC profile. Default 'srgb' */
    colorSpace?: ExportColorSpace;
    /** Long-edge downscale cap in pixels. 0 or undefined for full resolution */
    maxLongEdge?: number;
}
export interface ExportRecipe {
    readonly schemaVersion: number;
    readonly name: string;
    readonly format: string;
    readonly quality: number | null;
    readonly bitDepth: number;
    readonly maxLongEdge: number | null;
    readonly outputProfile: string;
    readonly renderingIntent: string;
    readonly metadataPolicy: string;
    readonly namingTemplate: string;
    readonly destination: string;
    readonly directory: string | null;
    readonly watermark: string | null;
    readonly overwritePolicy: string;
}
export interface ExportRecipeOptions {
    /** Path to source RAW file */
    rawPath: string;
    /** Raw XML content of XMP sidecar */
    xmpXml?: string;
    /** ExportRecipe object or serialized JSON string */
    recipe: ExportRecipe | string;
    /** Path to film LUTs directory (if a film look is used) */
    filmPath?: string | null;
    /** Path to write the output image file */
    outPath: string;
}
export interface ExportResult {
    ok: boolean;
    outPath: string;
    error?: string;
}
export interface ThumbnailOptions {
    rawPath: string;
    outPath: string;
    maxPx?: number;
    quality?: number;
}
export interface FilenameTemplateArgs {
    template: string;
    originalStem: string;
    ext: string;
    capturedAt: string | null;
    sequenceStart: number;
    sequenceIndex: number;
    sequencePadWidth: number;
}
export type FilenameResult = {
    ok: true;
    name: string;
} | {
    ok: false;
    code: number;
    error: string;
};
/** `sharpen()`'s mask-based (Lab) transfer options, #3504 task E5. */
export interface SharpenOptions {
    /** Gaussian sigma, 0.000001-10. Omit for sharp's fast mild 3x3 sharpen. */
    sigma?: number;
    /** Sharpening applied to "flat" areas. Default 1.0. */
    m1?: number;
    /** Sharpening applied to "jagged" areas. Default 2.0. */
    m2?: number;
    /** Threshold between flat and jagged. Default 2.0. */
    x1?: number;
    /** Maximum brightening. Default 10.0. */
    y2?: number;
    /** Maximum darkening. Default 20.0. */
    y3?: number;
}
/** `convolve()`'s arbitrary kernel, #3504 task E5. */
export interface ConvolveKernel {
    width: number;
    height: number;
    /** `width * height` values, row-major. */
    kernel: number[];
    /**
     * Divisor for the weighted sum. Omit to use the kernel's own sum (1 for a
     * zero-sum kernel, matching sharp) — an explicit `0` is NOT the same as
     * omitting this: sharp clips any non-positive explicit `scale` up to 1.
     */
    scale?: number;
    offset?: number;
}
