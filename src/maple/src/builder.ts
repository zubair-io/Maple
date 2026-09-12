/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  pushGamma,
  pushGreyscale,
  pushLinear,
  pushModulate,
  pushNegate,
  pushNormalise,
  pushTint,
  pushToColourspace,
} from './builder-colour';
import {
  setAvifOutput,
  setJpegOutput,
  setPngOutput,
  setTiffOutput,
  setWebpOutput,
} from './builder-encoders';
import {
  inputBytes,
  resolveMetadata,
  resolveTensor,
  resolveToRaw,
  runPipeline,
} from './builder-exec';
import { pushBlur, pushConvolve, pushMedian, pushSharpen, pushThreshold } from './builder-filter';
import {
  pushExtend,
  pushExtract,
  pushFlip,
  pushFlop,
  pushRotate,
  pushTrim,
} from './builder-geometry';
import { isRawDevelop, rawDevelopToBuffer, rawDevelopToFile } from './builder-raw-develop';
import {
  applyEffort,
  applyFormat,
  applyQuality,
  createBuilderState,
  formatForPath,
  resolveColour,
  resolveGravity,
  stateToOutput,
} from './builder-state';
import type { BuilderState } from './builder-state';
import type {
  AvifOutputOptions,
  Colour,
  CompositeLayer,
  ConvolveKernel,
  EncodeOptions,
  ExportColorSpace,
  ExportFormat,
  ExportRecipe,
  ExportResult,
  ExtendOptions,
  ExtractRegion,
  ImageMetadata,
  JpegOutputOptions,
  PngOutputOptions,
  RawPixelInput,
  RawPixels,
  RawPixelsAny,
  ResizeOptions,
  RotateOptions,
  SharpenOptions,
  TensorOptions,
  TensorResult,
  TiffOutputOptions,
  TrimOptions,
  WebpOutputOptions,
} from './types';

export class MapleImageBuilder {
  private readonly s: BuilderState;

  constructor(input: string | Uint8Array | Buffer | RawPixelInput) {
    this.s = createBuilderState(input);
  }

  /** Specify path to XMP sidecar */
  xmp(xmpPath: string): this {
    this.s.xmpPath = xmpPath;
    return this;
  }

  /** Apply raw XML content of XMP sidecar */
  applyXmp(xml: string): this {
    this.s.xmpXml = xml;
    return this;
  }

  /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
  xmpContent(xml: string): this {
    this.s.xmpXml = xml;
    return this;
  }

  /** Configure SIMD resampling dimensions and framing (sharp's `resize`) */
  resize(optionsOrWidth: ResizeOptions | number | null, height?: number | null): this {
    const opts: ResizeOptions =
      typeof optionsOrWidth === 'number' || optionsOrWidth === null || optionsOrWidth === undefined
        ? { width: optionsOrWidth ?? 0, height: height ?? 0 }
        : optionsOrWidth;
    // NOTE: `withoutEnlargement` defaults to `true` here — sharp defaults to
    // `false`. That divergence is documented in the README and the API
    // relies on it; do not "fix" it to match sharp.
    //
    // Last-wins: sharp treats repeated `.resize()` calls as overriding the
    // same pipeline stage (only one resample ever runs), not as stacking two
    // resamples. Drop any earlier `resize` op and emit only this call's, at
    // the position of this call — matching sharp's "the last call's params
    // win" behaviour.
    this.s.ops = this.s.ops.filter((op) => op.op !== 'resize');
    this.s.ops.push({
      op: 'resize',
      width: Math.max(0, opts.width ?? 0),
      height: Math.max(0, opts.height ?? 0),
      fit: opts.fit ?? 'inside',
      position: resolveGravity(opts.position ?? opts.gravity),
      kernel: opts.kernel ?? opts.filter ?? 'lanczos3',
      withoutEnlargement: opts.withoutEnlargement ?? true,
      withoutReduction: opts.withoutReduction ?? false,
      background: resolveColour(opts.background, [0, 0, 0, 255]),
    });
    return this;
  }

  /**
   * With no angle: auto-orient from the EXIF Orientation tag (the Tier 1
   * behaviour, and sharp's backwards-compatible default). With an angle:
   * rotate clockwise by that many degrees, padding with `background`.
   */
  rotate(angle?: number, options?: RotateOptions): this {
    pushRotate(this.s, angle, options);
    return this;
  }

  /** Extract/crop a region (sharp's `extract`). */
  extract(region: ExtractRegion): this {
    pushExtract(this.s, region);
    return this;
  }

  /** Pad one or more edges with a background colour (sharp's `extend`). */
  extend(options: ExtendOptions | number): this {
    pushExtend(this.s, options);
    return this;
  }

  /** Mirror about the horizontal axis. */
  flip(): this {
    pushFlip(this.s);
    return this;
  }

  /** Mirror about the vertical axis. */
  flop(): this {
    pushFlop(this.s);
    return this;
  }

  /** Crop a border of pixels similar to `background` (sharp's `trim`). */
  trim(options?: TrimOptions): this {
    pushTrim(this.s, options);
    return this;
  }

  /**
   * Set output container format and optional quality/effort.
   *
   * Naming a different container than an earlier `.jpeg()`/`.png()`/… call
   * discards that call's options — see `applyFormat`.
   */
  toFormat(format: ExportFormat, options?: EncodeOptions): this {
    applyFormat(this.s, format);
    if (options?.quality !== undefined) {
      applyQuality(this.s, options.quality);
    }
    if (options?.effort !== undefined) {
      applyEffort(this.s, options.effort);
    }
    return this;
  }

  /** Encode as JPEG with sharp's options. */
  jpeg(options?: JpegOutputOptions): this {
    setJpegOutput(this.s, options);
    return this;
  }

  /** Encode as PNG with sharp's options. */
  png(options?: PngOutputOptions): this {
    setPngOutput(this.s, options);
    return this;
  }

  /** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
  webp(options?: WebpOutputOptions): this {
    setWebpOutput(this.s, options);
    return this;
  }

  /** Encode as AVIF with sharp's options. */
  avif(options?: AvifOutputOptions): this {
    setAvifOutput(this.s, options);
    return this;
  }

  /** Encode as TIFF with sharp's options. */
  tiff(options?: TiffOutputOptions): this {
    setTiffOutput(this.s, options);
    return this;
  }

  /** Set output container format */
  format(format: ExportFormat): this {
    applyFormat(this.s, format);
    return this;
  }

  /**
   * Set output quality (1..100). Reaches an earlier `.jpeg()`/`.avif()`
   * call's output too; PNG, WebP and TIFF have no quality knob in Maple's
   * encoders, so there is nothing for it to change there.
   *
   * Last call wins, in both directions: `.quality(30).jpeg()` encodes at
   * `.jpeg()`'s own default of 80 (the per-format call is the later, more
   * specific instruction), while `.jpeg().quality(30)` encodes at 30.
   */
  quality(quality: number): this {
    applyQuality(this.s, quality);
    return this;
  }

  /** Set target primaries / ICC profile */
  colorSpace(space: ExportColorSpace): this {
    this.s.colorSpace = space;
    return this;
  }

  /**
   * Target colourspace. For bitmaps this rotates the primaries and tags the
   * output with the matching ICC profile; for the RAW develop path it also
   * selects the export primaries, as it did in Tier 1. `'b-w'` is the
   * greyscale conversion, the same thing `greyscale()` does — which is what
   * it means in sharp too.
   */
  toColourspace(space: 'srgb' | 'display-p3' | 'p3' | 'b-w'): this {
    pushToColourspace(this.s, space);
    return this;
  }

  /** Alternative spelling of `toColourspace`. */
  toColorspace(space: 'srgb' | 'display-p3' | 'p3' | 'b-w'): this {
    return this.toColourspace(space);
  }

  /** Convert to 8-bit greyscale, three identical channels. */
  greyscale(greyscale = true): this {
    pushGreyscale(this.s, greyscale);
    return this;
  }

  /** Alternative spelling of `greyscale`. */
  grayscale(grayscale = true): this {
    return this.greyscale(grayscale);
  }

  /**
   * sharp's `gamma(gamma, gammaOut)`. Our recipe's `gamma{exponent}` op is
   * a plain `x ** exponent` (unlike libvips' `vips_gamma`, which computes
   * `x ** (1/exponent)`), so matching sharp's net effect means pushing
   * `exponent: gamma` before the resize and `exponent: 1/gammaOut` after
   * it — see `builder-colour.ts`'s `pushGamma` for the full derivation.
   * With the defaults (2.2, 2.2) the pair is a net identity and the
   * RESIZE is what happens in the changed encoding.
   */
  gamma(gamma = 2.2, gammaOut?: number): this {
    pushGamma(this.s, gamma, gammaOut);
    return this;
  }

  /** `a * input + b`, per channel or scalar. */
  linear(a: number | number[] = 1, b: number | number[] = 0): this {
    pushLinear(this.s, a, b);
    return this;
  }

  /**
   * Produce the negative. `{ alpha: false }` spares the alpha channel, and
   * `negate(false)` is a no-op — sharp's own signature (and the same shape
   * as `greyscale(false)`).
   */
  negate(options?: boolean | { alpha?: boolean }): this {
    pushNegate(this.s, options);
    return this;
  }

  /** Stretch luminance between the given percentiles. */
  normalise(options?: { lower?: number; upper?: number }): this {
    pushNormalise(this.s, options?.lower ?? 1, options?.upper ?? 99);
    return this;
  }

  /** Alternative spelling of `normalise`. */
  normalize(options?: { lower?: number; upper?: number }): this {
    return this.normalise(options);
  }

  /** Scale L* and C* and rotate hue, in CIELCh. */
  modulate(options?: {
    brightness?: number;
    saturation?: number;
    hue?: number;
    lightness?: number;
  }): this {
    pushModulate(
      this.s,
      options?.brightness ?? 1,
      options?.saturation ?? 1,
      options?.hue ?? 0,
      options?.lightness ?? 0,
    );
    return this;
  }

  /** Keep each pixel's lightness, take the chroma from `tint`. */
  tint(tint: Colour | string): this {
    pushTint(this.s, tint);
    return this;
  }

  /** Set maximum long edge cap */
  maxLongEdge(px: number): this {
    this.s.maxLongEdge = Math.max(0, px);
    return this;
  }

  /** Set film LUTs directory */
  filmPath(dir: string): this {
    this.s.filmPath = dir;
    return this;
  }

  /** Use a saved ExportRecipe */
  recipe(recipe: ExportRecipe | string): this {
    this.s.exportRecipe = recipe;
    return this;
  }

  /** Use a saved ExportRecipe (alias) */
  exportRecipe(recipe: ExportRecipe | string): this {
    this.s.exportRecipe = recipe;
    return this;
  }

  /** Composite overlay image(s) over the processed image (sharp's `composite`). */
  composite(layers: CompositeLayer[]): this {
    const wire = layers.map((layer) => {
      if ((layer.left === undefined) !== (layer.top === undefined)) {
        throw new Error('composite: a layer must set both left and top, or neither');
      }
      const raw =
        'data' in layer.input
          ? {
              width: layer.input.width,
              height: layer.input.height,
              channels: layer.input.channels,
            }
          : null;
      const bytes = 'data' in layer.input ? layer.input.data : layer.input;
      return {
        aux: this.s.aux.add(bytes),
        raw,
        left: layer.left ?? null,
        top: layer.top ?? null,
        gravity: layer.gravity ?? 'centre',
        blend: layer.blend ?? 'over',
        tile: layer.tile ?? false,
      };
    });
    this.s.ops.push({ op: 'composite', layers: wire });
    return this;
  }

  /** Merge the alpha channel with a background and drop it. */
  flatten(options?: { background?: Colour | string }): this {
    this.s.ops.push({
      op: 'flatten',
      background: resolveColour(options?.background, [0, 0, 0, 255]),
    });
    return this;
  }

  /** Ensure the image has an alpha channel, filled with `alpha` (0-1). */
  ensureAlpha(alpha = 1): this {
    this.s.ops.push({ op: 'ensureAlpha', alpha: Math.max(0, Math.min(1, alpha)) });
    return this;
  }

  /** Drop the alpha channel without compositing. */
  removeAlpha(): this {
    this.s.ops.push({ op: 'removeAlpha' });
    return this;
  }

  /**
   * Blur. No argument (or `true`) = a fast 3x3 box blur; a sigma = a
   * Gaussian; `false` = no blur, as in sharp.
   */
  blur(options?: number | boolean | { sigma?: number }): this {
    pushBlur(this.s, options);
    return this;
  }

  /**
   * Unsharp mask on the L* channel (sharp's `sharpen`). No argument is
   * sharp's fast mild 3x3 kernel, and so is `true`; `false` is no sharpen.
   * A bare number is its deprecated positional `sharpen(sigma)` form — see
   * `pushSharpen` for the one domain difference between that form and the
   * object form.
   */
  sharpen(options?: number | boolean | SharpenOptions): this {
    pushSharpen(this.s, options);
    return this;
  }

  /** Square median filter; `size` defaults to 3, sharp's own default. */
  median(size = 3): this {
    pushMedian(this.s, size);
    return this;
  }

  /**
   * Binarise at `threshold`; `greyscale` decides via linear-light luma. A
   * threshold of `0` (or `false`) is a no-op, as in sharp; `true` is 128.
   */
  threshold(
    threshold: number | boolean = 128,
    options?: { greyscale?: boolean; grayscale?: boolean },
  ): this {
    pushThreshold(this.s, threshold, options);
    return this;
  }

  /** Convolve with an arbitrary kernel. */
  convolve(kernel: ConvolveKernel): this {
    pushConvolve(this.s, kernel);
    return this;
  }

  /** Native-size interleaved pixels, alpha preserved when the source has it. */
  async toRawAlpha(): Promise<RawPixelsAny> {
    const bytes = await inputBytes(this.s);
    const out = runPipeline(this.s, bytes, { format: 'raw' });
    return {
      data: new Uint8Array(out.buffer.buffer, out.buffer.byteOffset, out.buffer.byteLength),
      width: out.width,
      height: out.height,
      channels: out.channels as 3 | 4,
    };
  }

  /** Inspect image dimensions, format, orientation without full decode */
  async metadata(): Promise<ImageMetadata> {
    return resolveMetadata(this.s);
  }

  /** Check if image file or buffer is valid and uncorrupted by decoding payload */
  async validateIntegrity(): Promise<boolean> {
    try {
      const meta = await this.metadata();
      if (meta.width <= 0 || meta.height <= 0) return false;
      // Perform full decode check to catch truncated mdat or broken bitstream payloads
      await this.toBuffer();
      return true;
    } catch {
      return false;
    }
  }

  /** Normalize image orientation in-place on disk */
  async normalizeOrientationInPlace(): Promise<boolean> {
    if (!this.s.inputPath) {
      throw new Error('normalizeOrientationInPlace requires a file path input');
    }
    const meta = await this.metadata();
    if (meta.orientation <= 1) {
      return true; // Already normal
    }
    const ext = path.extname(this.s.inputPath) || '.jpg';
    const tempOut = `${this.s.inputPath}.orient_tmp.${Date.now()}.${crypto.randomUUID()}${ext}`;
    const targetFmt = this.s.format || (meta.format as ExportFormat) || 'jpeg';
    const res = await this.rotate().format(targetFmt).toFile(tempOut);
    if (!res.ok) {
      try {
        await fs.unlink(tempOut);
      } catch {}
      throw new Error(res.error || 'Failed to normalize orientation');
    }
    await fs.rename(tempOut, this.s.inputPath);
    return true;
  }

  /** Extract raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace) */
  async toRawRgb(options?: TensorOptions): Promise<TensorResult> {
    return resolveTensor(this.s, options);
  }

  /** Render or resize image directly to an in-memory Buffer */
  async toBuffer(): Promise<Buffer> {
    if (isRawDevelop(this.s)) {
      return await rawDevelopToBuffer(this.s, (outputPath) => this.toFile(outputPath));
    }
    const bytes = await inputBytes(this.s);
    return runPipeline(this.s, bytes, stateToOutput(this.s, 'jpeg')).buffer;
  }

  /** Execute export or resize and write to output file */
  async toFile(outputPath: string): Promise<ExportResult> {
    if (isRawDevelop(this.s)) {
      return await rawDevelopToFile(this.s, outputPath);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    try {
      const bytes = await inputBytes(this.s);
      const out = runPipeline(this.s, bytes, stateToOutput(this.s, formatForPath(outputPath)));
      await fs.writeFile(outputPath, out.buffer);
      return { ok: true, outPath: outputPath };
    } catch (error) {
      return {
        ok: false,
        outPath: outputPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
  async toRaw(): Promise<RawPixels> {
    return resolveToRaw(this.s);
  }
}

/**
 * Entry function to create a Maple image operation.
 */
export function maple(input: string | Uint8Array | Buffer | RawPixelInput): MapleImageBuilder {
  return new MapleImageBuilder(input);
}
