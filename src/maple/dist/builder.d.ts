/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */
import type { Colour, CompositeLayer, ConvolveKernel, EncodeOptions, ExportColorSpace, ExportFormat, ExportRecipe, ExportResult, ImageMetadata, RawPixelInput, RawPixels, RawPixelsAny, ResizeOptions, SharpenOptions, TensorOptions, TensorResult } from './types';
export declare class MapleImageBuilder {
    private readonly s;
    constructor(input: string | Uint8Array | Buffer | RawPixelInput);
    /** Specify path to XMP sidecar */
    xmp(xmpPath: string): this;
    /** Apply raw XML content of XMP sidecar */
    applyXmp(xml: string): this;
    /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
    xmpContent(xml: string): this;
    /** Configure SIMD resampling dimensions and framing */
    resize(optionsOrWidth: ResizeOptions | number | null, height?: number | null): this;
    /** Automatically rotate according to EXIF orientation */
    rotate(): this;
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
    /** Target colourspace (alias for colorSpace) */
    toColourspace(space: string): this;
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
    /** Blur. No argument = a fast 3x3 box blur; a sigma = a Gaussian. */
    blur(options?: number | {
        sigma?: number;
    }): this;
    /**
     * Unsharp mask on the L* channel (sharp's `sharpen`). No argument is
     * sharp's fast mild 3x3 kernel; a bare number is its deprecated
     * positional `sharpen(sigma)` form — see `pushSharpen` for the one
     * domain difference between that form and the object form.
     */
    sharpen(options?: number | SharpenOptions): this;
    /** Square median filter; `size` defaults to 3, sharp's own default. */
    median(size?: number): this;
    /** Binarise at `threshold`; `greyscale` decides via Rec.709 luma. */
    threshold(threshold?: number, options?: {
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
