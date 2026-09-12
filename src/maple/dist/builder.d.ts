/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */
import type { Colour, CompositeLayer, EncodeOptions, ExportColorSpace, ExportFormat, ExportRecipe, ExportResult, ExtendOptions, ExtractRegion, ImageMetadata, RawPixelInput, RawPixels, RawPixelsAny, ResizeOptions, RotateOptions, TensorOptions, TensorResult, TrimOptions } from './types';
export declare class MapleImageBuilder {
    private readonly s;
    constructor(input: string | Uint8Array | Buffer | RawPixelInput);
    /** Specify path to XMP sidecar */
    xmp(xmpPath: string): this;
    /** Apply raw XML content of XMP sidecar */
    applyXmp(xml: string): this;
    /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
    xmpContent(xml: string): this;
    /** Configure SIMD resampling dimensions and framing (sharp's `resize`) */
    resize(optionsOrWidth: ResizeOptions | number | null, height?: number | null): this;
    /**
     * With no angle: auto-orient from the EXIF Orientation tag (the Tier 1
     * behaviour, and sharp's backwards-compatible default). With an angle:
     * rotate clockwise by that many degrees, padding with `background`.
     */
    rotate(angle?: number, options?: RotateOptions): this;
    /** Extract/crop a region (sharp's `extract`). */
    extract(region: ExtractRegion): this;
    /** Pad one or more edges with a background colour (sharp's `extend`). */
    extend(options: ExtendOptions | number): this;
    /** Mirror about the horizontal axis. */
    flip(): this;
    /** Mirror about the vertical axis. */
    flop(): this;
    /** Crop a border of pixels similar to `background` (sharp's `trim`). */
    trim(options?: TrimOptions): this;
    /** Set output container format and optional quality/effort */
    toFormat(format: ExportFormat, options?: EncodeOptions): this;
    /** Encode as AVIF (sugar for `toFormat('avif', options)`) */
    avif(options?: EncodeOptions): this;
    /** Encode as JPEG (sugar for `toFormat('jpeg', options)`) */
    jpeg(options?: EncodeOptions): this;
    /** Encode as PNG (sugar for `toFormat('png')`) */
    png(): this;
    /** Encode as WebP (sugar for `toFormat('webp', options)`) */
    webp(options?: EncodeOptions): this;
    /** Set output container format */
    format(format: ExportFormat): this;
    /** Set output quality (1..100) */
    quality(quality: number): this;
    /** Set target primaries / ICC profile */
    colorSpace(space: ExportColorSpace): this;
    /**
     * Target colourspace. For bitmaps this rotates the primaries and tags the
     * output with the matching ICC profile; for the RAW develop path it also
     * selects the export primaries, as it did in Tier 1. `'b-w'` is the
     * greyscale conversion, the same thing `greyscale()` does — which is what
     * it means in sharp too.
     */
    toColourspace(space: 'srgb' | 'display-p3' | 'p3' | 'b-w'): this;
    /** Alternative spelling of `toColourspace`. */
    toColorspace(space: 'srgb' | 'display-p3' | 'p3' | 'b-w'): this;
    /** Convert to 8-bit greyscale, three identical channels. */
    greyscale(greyscale?: boolean): this;
    /** Alternative spelling of `greyscale`. */
    grayscale(grayscale?: boolean): this;
    /**
     * sharp's `gamma(gamma, gammaOut)`. Our recipe's `gamma{exponent}` op is
     * a plain `x ** exponent` (unlike libvips' `vips_gamma`, which computes
     * `x ** (1/exponent)`), so matching sharp's net effect means pushing
     * `exponent: gamma` before the resize and `exponent: 1/gammaOut` after
     * it — see `builder-colour.ts`'s `pushGamma` for the full derivation.
     * With the defaults (2.2, 2.2) the pair is a net identity and the
     * RESIZE is what happens in the changed encoding.
     */
    gamma(gamma?: number, gammaOut?: number): this;
    /** `a * input + b`, per channel or scalar. */
    linear(a?: number | number[], b?: number | number[]): this;
    /**
     * Produce the negative. `{ alpha: false }` spares the alpha channel, and
     * `negate(false)` is a no-op — sharp's own signature (and the same shape
     * as `greyscale(false)`).
     */
    negate(options?: boolean | {
        alpha?: boolean;
    }): this;
    /** Stretch luminance between the given percentiles. */
    normalise(options?: {
        lower?: number;
        upper?: number;
    }): this;
    /** Alternative spelling of `normalise`. */
    normalize(options?: {
        lower?: number;
        upper?: number;
    }): this;
    /** Scale L* and C* and rotate hue, in CIELCh. */
    modulate(options?: {
        brightness?: number;
        saturation?: number;
        hue?: number;
        lightness?: number;
    }): this;
    /** Keep each pixel's lightness, take the chroma from `tint`. */
    tint(tint: Colour | string): this;
    /** Set maximum long edge cap */
    maxLongEdge(px: number): this;
    /** Set film LUTs directory */
    filmPath(dir: string): this;
    /** Use a saved ExportRecipe */
    recipe(recipe: ExportRecipe | string): this;
    /** Use a saved ExportRecipe (alias) */
    exportRecipe(recipe: ExportRecipe | string): this;
    /** Composite overlay image(s) over the processed image (sharp's `composite`). */
    composite(layers: CompositeLayer[]): this;
    /** Merge the alpha channel with a background and drop it. */
    flatten(options?: {
        background?: Colour | string;
    }): this;
    /** Ensure the image has an alpha channel, filled with `alpha` (0-1). */
    ensureAlpha(alpha?: number): this;
    /** Drop the alpha channel without compositing. */
    removeAlpha(): this;
    /** Native-size interleaved pixels, alpha preserved when the source has it. */
    toRawAlpha(): Promise<RawPixelsAny>;
    /** Inspect image dimensions, format, orientation without full decode */
    metadata(): Promise<ImageMetadata>;
    /** Check if image file or buffer is valid and uncorrupted by decoding payload */
    validateIntegrity(): Promise<boolean>;
    /** Normalize image orientation in-place on disk */
    normalizeOrientationInPlace(): Promise<boolean>;
    /** Extract raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace) */
    toRawRgb(options?: TensorOptions): Promise<TensorResult>;
    /** Render or resize image directly to an in-memory Buffer */
    toBuffer(): Promise<Buffer>;
    /** Execute export or resize and write to output file */
    toFile(outputPath: string): Promise<ExportResult>;
    /** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
    toRaw(): Promise<RawPixels>;
}
/**
 * Entry function to create a Maple image operation.
 */
export declare function maple(input: string | Uint8Array | Buffer | RawPixelInput): MapleImageBuilder;
