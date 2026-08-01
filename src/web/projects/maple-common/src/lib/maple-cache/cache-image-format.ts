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
  if (format === 'jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (format === 'png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return (
      bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
    );
  }

  if (format === 'webp') {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
    );
  }

  if (bytes.length < 12) return false;
  const isFtyp = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  if (!isFtyp) return false;

  const brandAt = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (brandAt(8) === 'avif' || brandAt(8) === 'avis') return true;

  // AVIF may use the generic `mif1` major brand and advertise `avif`/`avis`
  // in the compatible-brand list. Restrict the scan to the declared ftyp box
  // (or the available header bytes for deliberately-short test fixtures).
  const declaredBoxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const boxEnd = Math.min(declaredBoxSize || bytes.length, bytes.length);
  for (let offset = 16; offset + 3 < boxEnd; offset += 4) {
    const brand = brandAt(offset);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}
