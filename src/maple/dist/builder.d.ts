/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */
import type { AvifOutputOptions, Colour, CompositeLayer, ConvolveKernel, EncodeOptions, ExportColorSpace, ExportFormat, ExportRecipe, ExportResult, ExtendOptions, ExtractRegion, ImageMetadata, ImageStats, JpegOutputOptions, PngOutputOptions, RawPixelInput, RawPixels, RawPixelsAny, ResizeOptions, RotateOptions, SharpenOptions, TensorOptions, TensorResult, TiffOutputOptions, TrimOptions, WebpOutputOptions } from './types';
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
    /**
     * Set output container format and optional quality/effort.
     *
     * Naming a different container than an earlier `.jpeg()`/`.png()`/… call
     * discards that call's options — see `applyFormat`.
     */
    toFormat(format: ExportFormat, options?: EncodeOptions): this;
    /** Encode as JPEG with sharp's options. */
    jpeg(options?: JpegOutputOptions): this;
    /** Encode as PNG with sharp's options. */
    png(options?: PngOutputOptions): this;
    /** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
    webp(options?: WebpOutputOptions): this;
    /** Encode as AVIF with sharp's options. */
    avif(options?: AvifOutputOptions): this;
    /** Encode as TIFF with sharp's options. */
    tiff(options?: TiffOutputOptions): this;
    /** Set output container format */
    format(format: ExportFormat): this;
    /**
     * Set output quality (1..100). Reaches an earlier `.jpeg()`/`.avif()`
     * call's output too; PNG, WebP and TIFF have no quality knob in Maple's
     * encoders, so there is nothing for it to change there.
     *
     * Last call wins, in both directions: `.quality(30).jpeg()` encodes at
     * `.jpeg()`'s own default of 80 (the per-format call is the later, more
     * specific instruction), while `.jpeg().quality(30)` encodes at 30.
     */
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
    /**
     * Blur. No argument (or `true`) = a fast 3x3 box blur; a sigma = a
     * Gaussian; `false` = no blur, as in sharp.
     */
    blur(options?: number | boolean | {
        sigma?: number;
    }): this;
    /**
     * Unsharp mask on the L* channel (sharp's `sharpen`). No argument is
     * sharp's fast mild 3x3 kernel, and so is `true`; `false` is no sharpen.
     * A bare number is its deprecated positional `sharpen(sigma)` form — see
     * `pushSharpen` for the one domain difference between that form and the
     * object form.
     */
    sharpen(options?: number | boolean | SharpenOptions): this;
    /** Square median filter; `size` defaults to 3, sharp's own default. */
    median(size?: number): this;
    /**
     * Binarise at `threshold`; `greyscale` decides via linear-light luma. A
     * threshold of `0` (or `false`) is a no-op, as in sharp; `true` is 128.
     */
    threshold(threshold?: number | boolean, options?: {
        greyscale?: boolean;
        grayscale?: boolean;
    }): this;
    /** Convolve with an arbitrary kernel. */
    convolve(kernel: ConvolveKernel): this;
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
    /** Pixel-derived statistics for every channel (sharp's `stats`). */
    stats(): Promise<ImageStats>;
    /** Keep every metadata block from the input (sharp's `keepMetadata`). */
    keepMetadata(): this;
    /** Keep most metadata and optionally set the orientation or density (sharp's `withMetadata`). */
    withMetadata(options?: {
        orientation?: number;
        density?: number;
    }): this;
    /**
     * Embed this EXIF block (a bare TIFF block, starting `II*` or `MM*`).
     * Diverges from sharp's `withExif({IFD0: {...}})` — see the doc on
     * `applyWithExif` in `builder-metadata.ts`.
     */
    withExif(exif: Uint8Array | Buffer): this;
    /**
     * Tag the output with an ICC profile: `'srgb'` (Maple's own built-in
     * profile), a filesystem path, or raw profile bytes. This never converts
     * pixels, which is why `'p3'` is a named error — see the doc on
     * `applyWithIccProfile` in `builder-metadata.ts` for that and for the
     * other divergences from sharp's own `string`-only signature.
     */
    withIccProfile(icc: string | Uint8Array | Buffer): this;
    /** Embed this XMP packet. */
    withXmp(xmp: string | Uint8Array | Buffer): this;
    /** Render or resize image directly to an in-memory Buffer */
    toBuffer(): Promise<Buffer>;
    /**
     * Execute export or resize and write to output file.
     *
     * Both branches return `{ ok: false, error }` on failure rather than
     * throwing — including `assertRawDevelopOutput`'s synchronous rejection of
     * an unsupported per-format option on a RAW-develop input, which used to
     * escape as a rejected promise while every other `toFile` failure (a
     * native export error, a bitmap encode error) already came back this way.
     * The RAW-develop branch's own try/catch lives inside
     * `rawDevelopToFile` (`builder-raw-develop.ts`) — its `assertRawDevelopOutput`
     * call sits inside that same try, so the imported function already
     * resolves rather than rejects for this failure. `toBuffer()` on a
     * RAW-develop input still throws: `rawDevelopToBuffer` calls `toFile`
     * internally and re-throws on `!ok`, so that behaviour is unchanged.
     */
    toFile(outputPath: string): Promise<ExportResult>;
    /** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
    toRaw(): Promise<RawPixels>;
}
/**
 * Entry function to create a Maple image operation.
 */
export declare function maple(input: string | Uint8Array | Buffer | RawPixelInput): MapleImageBuilder;
