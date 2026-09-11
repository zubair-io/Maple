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
import { exportImage, exportRecipe } from './export';
import { loadNativeBinding } from './native';
import type { NativeBinding } from './native';
import type {
  EncodeOptions,
  ExportColorSpace,
  ExportFormat,
  ExportRecipe,
  ExportResult,
  ImageMetadata,
  RawPixelInput,
  RawPixels,
  ResizeOptions,
  TensorOptions,
  TensorResult,
} from './types';

const RAW_EXTENSIONS = new Set([
  '.dng',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.arw',
  '.srf',
  '.sr2',
  '.pef',
  '.ptx',
  '.raf',
  '.rw2',
  '.orf',
  '.srw',
  '.erf',
  '.kdc',
  '.mos',
  '.mrw',
  '.3fr',
  '.fff',
]);

export function isRawPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

export class MapleImageBuilder {
  private _inputPath: string | null = null;
  private _inputBytes: Uint8Array | null = null;
  private _rawInput: RawPixelInput | null = null;

  private _xmpPath: string | null = null;
  private _xmpXml: string | null = null;
  private _format: ExportFormat | null = null;
  private _quality = 92;
  private _colorSpace: ExportColorSpace = 'srgb';
  private _maxLongEdge = 0;
  private _filmPath: string | null = null;
  private _recipe: ExportRecipe | string | null = null;

  // Raster resize options
  private _resizeWidth = 0;
  private _resizeHeight = 0;
  private _resizeFit: 'inside' | 'fill' | 'cover' = 'inside';
  private _withoutEnlargement = true;
  private _autoOrient = false;
  private _removeAlpha = false;
  private _filter: 0 | 1 | 2 = 0;
  private _effort = 0;

  constructor(input: string | Uint8Array | Buffer | RawPixelInput) {
    if (typeof input === 'string') {
      this._inputPath = input;
    } else if ('data' in input && 'width' in input) {
      this._rawInput = input;
    } else if (input instanceof Uint8Array) {
      this._inputBytes = input;
    } else {
      this._inputBytes = new Uint8Array(input);
    }
  }

  /** Specify path to XMP sidecar */
  xmp(xmpPath: string): this {
    this._xmpPath = xmpPath;
    return this;
  }

  /** Apply raw XML content of XMP sidecar */
  applyXmp(xml: string): this {
    this._xmpXml = xml;
    return this;
  }

  /** Specify raw XML content of XMP sidecar (alias for applyXmp) */
  xmpContent(xml: string): this {
    this._xmpXml = xml;
    return this;
  }

  /** Configure SIMD resampling dimensions and framing */
  resize(optionsOrWidth: ResizeOptions | number, height?: number): this {
    if (typeof optionsOrWidth === 'number') {
      this._resizeWidth = Math.max(0, optionsOrWidth);
      this._resizeHeight = Math.max(0, height ?? 0);
    } else {
      this._resizeWidth = Math.max(0, optionsOrWidth.width ?? 0);
      this._resizeHeight = Math.max(0, optionsOrWidth.height ?? 0);
      if (optionsOrWidth.fit) {
        this._resizeFit = optionsOrWidth.fit;
      }
      if (optionsOrWidth.withoutEnlargement !== undefined) {
        this._withoutEnlargement = optionsOrWidth.withoutEnlargement;
      }
      if (optionsOrWidth.filter) {
        this._filter =
          optionsOrWidth.filter === 'bilinear' ? 1 : optionsOrWidth.filter === 'nearest' ? 2 : 0;
      }
    }
    return this;
  }

  /** Automatically rotate according to EXIF orientation */
  rotate(): this {
    this._autoOrient = true;
    return this;
  }

  /** Set output container format and optional quality/effort */
  toFormat(format: ExportFormat, options?: EncodeOptions): this {
    this._format = format;
    if (options?.quality !== undefined) {
      this._quality = Math.max(1, Math.min(100, options.quality));
    }
    if (options?.effort !== undefined) {
      this._effort = Math.max(0, Math.min(9, options.effort));
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
    this._format = format;
    return this;
  }

  /** Set output quality (1..100) */
  quality(quality: number): this {
    this._quality = Math.max(1, Math.min(100, quality));
    return this;
  }

  /** Set target primaries / ICC profile */
  colorSpace(space: ExportColorSpace): this {
    this._colorSpace = space;
    return this;
  }

  /** Target colourspace (alias for colorSpace) */
  toColourspace(space: string): this {
    if (space === 'display-p3' || space === 'p3') {
      this._colorSpace = 'display-p3';
    } else {
      this._colorSpace = 'srgb';
    }
    return this;
  }

  /** Strip alpha channel from image output */
  removeAlpha(): this {
    this._removeAlpha = true;
    return this;
  }

  /** Set maximum long edge cap */
  maxLongEdge(px: number): this {
    this._maxLongEdge = Math.max(0, px);
    return this;
  }

  /** Set film LUTs directory */
  filmPath(dir: string): this {
    this._filmPath = dir;
    return this;
  }

  /** Use a saved ExportRecipe */
  recipe(recipe: ExportRecipe | string): this {
    this._recipe = recipe;
    return this;
  }

  /** Use a saved ExportRecipe (alias) */
  exportRecipe(recipe: ExportRecipe | string): this {
    this._recipe = recipe;
    return this;
  }

  /** Bitmask for the v2 raster entry points: bit0 fill, bit1 auto-orient, bit2 allow
   * enlargement, bit3 cover (wins over fill). */
  private flags(): number {
    const fit = this._resizeFit === 'cover' ? 8 : this._resizeFit === 'fill' ? 1 : 0;
    return fit | (this._autoOrient ? 2 : 0) | (this._withoutEnlargement ? 0 : 4);
  }

  /** Inspect image dimensions, format, orientation without full decode */
  async metadata(): Promise<ImageMetadata> {
    const native = loadNativeBinding();

    if (this._rawInput) {
      return {
        width: this._rawInput.width,
        height: this._rawInput.height,
        format: 'raw',
        channels: this._rawInput.channels,
        orientation: 1,
      };
    }

    if (this._inputBytes) {
      const res = native.rasterProbeMetadataBuf(this._inputBytes);
      if (!res.ok || !res.metadata) {
        throw new Error(res.error || 'Failed to probe metadata');
      }
      return {
        width: res.metadata.width,
        height: res.metadata.height,
        format: res.metadata.format,
        channels: res.metadata.channels,
        orientation: res.metadata.orientation,
        isRaw: res.metadata.format === 'dng',
      };
    }

    if (!this._inputPath) {
      throw new Error('No input provided to MapleImageBuilder');
    }

    const res = native.rasterProbeMetadata(this._inputPath);
    if (!res.ok || !res.metadata) {
      throw new Error(res.error || `Failed to probe metadata for ${this._inputPath}`);
    }

    return {
      width: res.metadata.width,
      height: res.metadata.height,
      format: res.metadata.format || path.extname(this._inputPath).replace('.', '').toLowerCase(),
      channels: res.metadata.channels,
      orientation: res.metadata.orientation,
      isRaw: isRawPath(this._inputPath) || res.metadata.format === 'dng',
    };
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
    if (!this._inputPath) {
      throw new Error('normalizeOrientationInPlace requires a file path input');
    }
    const meta = await this.metadata();
    if (meta.orientation <= 1) {
      return true; // Already normal
    }
    const ext = path.extname(this._inputPath) || '.jpg';
    const tempOut = `${this._inputPath}.orient_tmp.${Date.now()}.${crypto.randomUUID()}${ext}`;
    const targetFmt = this._format || (meta.format as ExportFormat) || 'jpeg';
    const res = await this.rotate().format(targetFmt).toFile(tempOut);
    if (!res.ok) {
      try {
        await fs.unlink(tempOut);
      } catch {}
      throw new Error(res.error || 'Failed to normalize orientation');
    }
    await fs.rename(tempOut, this._inputPath);
    return true;
  }

  /** Extract raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace) */
  async toRawRgb(options?: TensorOptions): Promise<TensorResult> {
    const native = loadNativeBinding();

    let bytes = this._inputBytes;
    if (!bytes && this._inputPath) {
      bytes = await fs.readFile(this._inputPath);
    }
    if (!bytes || bytes.length === 0) {
      throw new Error('Input image is empty');
    }

    const targetSize = options?.targetSize ?? (this._resizeWidth || 640);
    const layoutNum = options?.layout === 'hwc' ? 1 : 0;
    const normNum =
      options?.normalize === 'insightface' ? 1 : options?.normalize === 'zeroToOne' ? 2 : 0;

    const res = native.rasterExtractTensor(bytes, targetSize, layoutNum, normNum);
    if (!res.ok || !res.tensor) {
      throw new Error(res.error || 'Failed to extract tensor');
    }

    return {
      data: res.tensor,
      width: targetSize,
      height: targetSize,
      channels: 3,
    };
  }

  /** Render or resize image directly to an in-memory Buffer */
  async toBuffer(): Promise<Buffer> {
    const native = loadNativeBinding();

    if (this._rawInput) {
      const r = this._rawInput;
      const res = native.rasterFromRawRenderBuf(
        r.data,
        r.width,
        r.height,
        r.channels,
        this._resizeWidth,
        this._resizeHeight,
        this.flags(),
        this._filter,
        this._format || 'jpeg',
        this._quality,
        this._effort,
      );
      if (!res.ok || !res.buffer) {
        throw new Error(res.error || 'Failed to encode raw pixels');
      }
      return res.buffer;
    }

    // Non-RAW bitmap in-memory path
    let bytes = this._inputBytes;
    if (!bytes && this._inputPath && !isRawPath(this._inputPath)) {
      bytes = await fs.readFile(this._inputPath);
    }

    if (bytes) {
      const res = native.rasterRenderBuf(
        bytes,
        this._resizeWidth,
        this._resizeHeight,
        this.flags(),
        this._filter,
        this._format || 'jpeg',
        this._quality,
        this._effort,
      );

      if (!res.ok || !res.buffer) {
        throw new Error(res.error || 'Failed to transcode image to buffer');
      }

      return res.buffer;
    }

    // RAW pipeline toBuffer fallback via tmp file
    if (this._inputPath) {
      const ext = this._format ? `.${this._format === 'jpeg' ? 'jpg' : this._format}` : '.jpg';
      const tmpFile = path.join(
        os.tmpdir(),
        `maple_buf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
      );
      try {
        const fileRes = await this.toFile(tmpFile);
        if (!fileRes.ok) {
          throw new Error(fileRes.error || 'Failed to develop RAW to buffer');
        }
        const buf = await fs.readFile(tmpFile);
        return buf;
      } finally {
        try {
          await fs.unlink(tmpFile);
        } catch {}
      }
    }

    throw new Error('No input provided to MapleImageBuilder');
  }

  /** Execute export or resize and write to output file */
  async toFile(outputPath: string): Promise<ExportResult> {
    // 1. Saved ExportRecipe execution
    if (this._recipe && this._inputPath) {
      return exportRecipe({
        rawPath: this._inputPath,
        xmpXml: this._xmpXml ?? undefined,
        recipe: this._recipe,
        filmPath: this._filmPath,
        outPath: outputPath,
      });
    }

    // 2. Full RAW development pipeline
    if (this._inputPath && (isRawPath(this._inputPath) || this._xmpPath || this._xmpXml)) {
      return exportImage({
        rawPath: this._inputPath,
        xmpPath: this._xmpPath,
        format: this._format ?? undefined,
        quality: this._quality,
        colorSpace: this._colorSpace,
        maxLongEdge: this._maxLongEdge || this._resizeWidth || 0,
        outPath: outputPath,
      });
    }

    // 3. Fast non-RAW bitmap resize & transcode
    const native = loadNativeBinding();
    const parentDir = path.dirname(outputPath);
    await fs.mkdir(parentDir, { recursive: true });

    const targetFormat = this._format || 'jpeg';

    if (this._rawInput) {
      const r = this._rawInput;
      const res = native.rasterFromRawRenderBuf(
        r.data,
        r.width,
        r.height,
        r.channels,
        this._resizeWidth,
        this._resizeHeight,
        this.flags(),
        this._filter,
        targetFormat,
        this._quality,
        this._effort,
      );
      if (!res.ok || !res.buffer) {
        return { ok: false, outPath: outputPath, error: res.error };
      }
      await fs.writeFile(outputPath, res.buffer);
      return { ok: true, outPath: outputPath };
    }

    let bytes = this._inputBytes;
    if (!bytes && this._inputPath) {
      bytes = await fs.readFile(this._inputPath);
    }

    if (bytes) {
      const res = native.rasterRenderBuf(
        bytes,
        this._resizeWidth,
        this._resizeHeight,
        this.flags(),
        this._filter,
        targetFormat,
        this._quality,
        this._effort,
      );
      if (!res.ok || !res.buffer) {
        return { ok: false, outPath: outputPath, error: res.error };
      }
      await fs.writeFile(outputPath, res.buffer);
      return { ok: true, outPath: outputPath };
    }

    return { ok: false, outPath: outputPath, error: 'No input provided' };
  }

  /** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
  async toRaw(): Promise<RawPixels> {
    const native = loadNativeBinding();
    if (this._rawInput) {
      const r = this._rawInput;
      const png = native.rasterFromRawRenderBuf(
        r.data,
        r.width,
        r.height,
        r.channels,
        0,
        0,
        0,
        0,
        'png',
        0,
        0,
      );
      if (!png.ok || !png.buffer) {
        throw new Error(png.error || 'Failed to normalise raw pixels');
      }
      return this.decodeRgb8(native, png.buffer);
    }
    const bytes = this._inputBytes ?? (this._inputPath ? await fs.readFile(this._inputPath) : null);
    if (!bytes || bytes.length === 0) {
      throw new Error('Input image is empty');
    }
    return this.decodeRgb8(native, bytes);
  }

  private decodeRgb8(native: NativeBinding, bytes: Uint8Array): RawPixels {
    const res = native.rasterDecodeRgb8Buf(bytes, this._autoOrient);
    if (!res.ok || !res.buffer || res.width === undefined || res.height === undefined) {
      throw new Error(res.error || 'Failed to decode to RGB8');
    }
    return {
      data: new Uint8Array(res.buffer.buffer, res.buffer.byteOffset, res.buffer.byteLength),
      width: res.width,
      height: res.height,
      channels: 3,
    };
  }
}

/**
 * Entry function to create a Maple image operation.
 */
export function maple(input: string | Uint8Array | Buffer | RawPixelInput): MapleImageBuilder {
  return new MapleImageBuilder(input);
}
