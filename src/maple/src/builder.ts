/**
 * Fluent builder API for Maple image operations.
 *
 * Provides a unified chaining interface for RAW photo development,
 * non-RAW bitmap SIMD resizing, in-memory transcoding, and AI tensor extraction.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inputBytes,
  resolveMetadata,
  resolveTensor,
  resolveToRaw,
  runPipeline,
} from './builder-exec';
import {
  createBuilderState,
  formatForPath,
  isRawPath,
  kernelFromFilter,
  lastResizeWidth,
  resolveColour,
  stateToOutput,
} from './builder-state';
import type { BuilderState } from './builder-state';
import { exportImage, exportRecipe } from './export';
import type {
  Colour,
  CompositeLayer,
  EncodeOptions,
  ExportColorSpace,
  ExportFormat,
  ExportRecipe,
  ExportResult,
  ImageMetadata,
  RawPixelInput,
  RawPixels,
  RawPixelsAny,
  ResizeOptions,
  TensorOptions,
  TensorResult,
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

  /** Configure SIMD resampling dimensions and framing */
  resize(optionsOrWidth: ResizeOptions | number | null, height?: number | null): this {
    const opts: ResizeOptions =
      typeof optionsOrWidth === 'number' || optionsOrWidth === null
        ? { width: optionsOrWidth ?? 0, height: height ?? 0 }
        : optionsOrWidth;
    // NOTE: `withoutEnlargement` defaults to `true` here — sharp defaults to
    // `false`. That divergence is documented in the README and the API
    // relies on it; do not "fix" it to match sharp.
    this.s.ops.push({
      op: 'resize',
      width: Math.max(0, opts.width ?? 0),
      height: Math.max(0, opts.height ?? 0),
      fit: opts.fit ?? 'inside',
      kernel: kernelFromFilter(opts.filter),
      withoutEnlargement: opts.withoutEnlargement ?? true,
    });
    return this;
  }

  /** Automatically rotate according to EXIF orientation */
  rotate(): this {
    this.s.autoOrient = true;
    return this;
  }

  /** Set output container format and optional quality/effort */
  toFormat(format: ExportFormat, options?: EncodeOptions): this {
    this.s.format = format;
    if (options?.quality !== undefined) {
      this.s.quality = Math.max(1, Math.min(100, options.quality));
    }
    if (options?.effort !== undefined) {
      this.s.effort = Math.max(0, Math.min(9, options.effort));
    }
    return this;
  }

  /** Encode as AVIF (sugar for `toFormat('avif', options)`) */
  avif(options?: EncodeOptions): this {
    return this.toFormat('avif', options);
  }

  /** Encode as JPEG (sugar for `toFormat('jpeg', options)`) */
  jpeg(options?: EncodeOptions): this {
    return this.toFormat('jpeg', options);
  }

  /** Encode as PNG (sugar for `toFormat('png')`) */
  png(): this {
    return this.toFormat('png');
  }

  /** Encode as WebP (sugar for `toFormat('webp', options)`) */
  webp(options?: EncodeOptions): this {
    return this.toFormat('webp', options);
  }

  /** Set output container format */
  format(format: ExportFormat): this {
    this.s.format = format;
    return this;
  }

  /** Set output quality (1..100) */
  quality(quality: number): this {
    this.s.quality = Math.max(1, Math.min(100, quality));
    return this;
  }

  /** Set target primaries / ICC profile */
  colorSpace(space: ExportColorSpace): this {
    this.s.colorSpace = space;
    return this;
  }

  /** Target colourspace (alias for colorSpace) */
  toColourspace(space: string): this {
    this.s.colorSpace = space === 'display-p3' || space === 'p3' ? 'display-p3' : 'srgb';
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

  /**
   * True when this builder describes a RAW develop rather than a bitmap
   * transform: a recipe, an XMP sidecar, or a RAW file path as input.
   */
  private isRawDevelop(): boolean {
    return (
      this.s.inputPath !== null &&
      (this.s.exportRecipe !== null ||
        this.s.xmpPath !== null ||
        this.s.xmpXml !== null ||
        isRawPath(this.s.inputPath))
    );
  }

  /** Saved-recipe or XMP-driven RAW development, rendered to a tmp file and read back. */
  private async rawDevelopToBuffer(): Promise<Buffer> {
    const ext = this.s.format ? `.${this.s.format === 'jpeg' ? 'jpg' : this.s.format}` : '.jpg';
    const tmpFile = path.join(
      os.tmpdir(),
      `maple_buf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
    );
    try {
      const fileRes = await this.toFile(tmpFile);
      if (!fileRes.ok) {
        throw new Error(fileRes.error || 'Failed to develop RAW to buffer');
      }
      return await fs.readFile(tmpFile);
    } finally {
      try {
        await fs.unlink(tmpFile);
      } catch {}
    }
  }

  /** Saved-recipe or XMP-driven RAW development, written straight to `outputPath`. */
  private async rawDevelopToFile(outputPath: string): Promise<ExportResult> {
    const rawPath = this.s.inputPath as string;
    if (this.s.exportRecipe) {
      return exportRecipe({
        rawPath,
        xmpXml: this.s.xmpXml ?? undefined,
        recipe: this.s.exportRecipe,
        filmPath: this.s.filmPath,
        outPath: outputPath,
      });
    }
    return exportImage({
      rawPath,
      xmpPath: this.s.xmpPath,
      format: this.s.format ?? undefined,
      quality: this.s.quality,
      colorSpace: this.s.colorSpace,
      maxLongEdge: this.s.maxLongEdge || lastResizeWidth(this.s),
      outPath: outputPath,
    });
  }

  /** Render or resize image directly to an in-memory Buffer */
  async toBuffer(): Promise<Buffer> {
    if (this.isRawDevelop()) {
      return await this.rawDevelopToBuffer();
    }
    const bytes = await inputBytes(this.s);
    return runPipeline(this.s, bytes, stateToOutput(this.s, 'jpeg')).buffer;
  }

  /** Execute export or resize and write to output file */
  async toFile(outputPath: string): Promise<ExportResult> {
    if (this.isRawDevelop()) {
      return await this.rawDevelopToFile(outputPath);
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
