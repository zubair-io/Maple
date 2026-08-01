import type { ThumbFormat } from '../raw-pipeline/image-utils';

export type PreviewCacheFormat = 'avif' | 'jpeg' | 'webp' | 'png';

interface PreviewFormatDescriptor {
  readonly extension: 'avif' | 'jpg' | 'webp' | 'png';
  readonly mimeType: 'image/avif' | 'image/jpeg' | 'image/webp' | 'image/png';
}

export const PREVIEW_CACHE_FORMATS: Readonly<Record<PreviewCacheFormat, PreviewFormatDescriptor>> =
  {
    avif: { extension: 'avif', mimeType: 'image/avif' },
    jpeg: { extension: 'jpg', mimeType: 'image/jpeg' },
    webp: { extension: 'webp', mimeType: 'image/webp' },
    png: { extension: 'png', mimeType: 'image/png' },
  };

export function previewFormatForMime(mimeType: string): PreviewCacheFormat | null {
  for (const [format, descriptor] of Object.entries(PREVIEW_CACHE_FORMATS)) {
    if (descriptor.mimeType === mimeType) return format as PreviewCacheFormat;
  }
  return null;
}

export function isPreviewCacheFormat(value: unknown): value is PreviewCacheFormat {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(PREVIEW_CACHE_FORMATS, value)
  );
}

interface SignatureSegment {
  readonly offset: number;
  readonly bytes: readonly number[];
}

const FIXED_SIGNATURES: Partial<
  Readonly<Record<ThumbFormat | PreviewCacheFormat, readonly SignatureSegment[]>>
> = {
  jpeg: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  png: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  webp: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};

const matchesSegment = (bytes: Uint8Array, segment: SignatureSegment): boolean =>
  segment.offset + segment.bytes.length <= bytes.length &&
  segment.bytes.every((byte, index) => bytes[segment.offset + index] === byte);

const isAvifBrand = (bytes: Uint8Array, offset: number): boolean => {
  const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return brand === 'avif' || brand === 'avis';
};

const hasAvifSignature = (bytes: Uint8Array): boolean => {
  if (!matchesSegment(bytes, { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] })) return false;
  if (isAvifBrand(bytes, 8)) return true;

  // AVIF may use the generic `mif1` major brand and advertise `avif`/`avis`
  // in the compatible-brand list. Restrict the scan to the declared ftyp box
  // (or the available header bytes for deliberately-short test fixtures).
  const declaredBoxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const boxEnd = Math.min(declaredBoxSize || bytes.length, bytes.length);
  for (let offset = 16; offset + 3 < boxEnd; offset += 4) {
    if (isAvifBrand(bytes, offset)) return true;
  }
  return false;
};

/**
 * Verify the container signature before assigning a cache MIME type.
 *
 * File System Access folders can outlive Maple versions and can be modified by
 * other tools, so an extension is not sufficient evidence of the bytes' type.
 * This is deliberately a cheap header check on the cache read/write path, not
 * a full image decode.
 */
export function hasCacheImageSignature(
  bytes: Uint8Array,
  format: ThumbFormat | PreviewCacheFormat,
): boolean {
  const fixedSignature = FIXED_SIGNATURES[format];
  return fixedSignature
    ? fixedSignature.every((segment) => matchesSegment(bytes, segment))
    : hasAvifSignature(bytes);
}
