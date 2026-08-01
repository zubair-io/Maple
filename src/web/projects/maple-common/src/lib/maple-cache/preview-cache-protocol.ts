import {
  isPreviewCacheFormat,
  PREVIEW_CACHE_FORMATS,
  type PreviewCacheFormat,
} from './cache-image-format';

export interface PreviewSourceIdentity {
  size: number;
  lastModified: number;
}

export interface PreviewCacheDescriptor {
  version: 1;
  format: PreviewCacheFormat;
  mimeType: string;
  source: PreviewSourceIdentity;
  /** Filesystem mtime of the declared artifact. A newer canonical AVIF written
   * by Apple/API supersedes the Hosted-private slot. */
  artifactLastModified: number;
}

export function previewCacheDir(relDir: string): string {
  return relDir ? `${relDir}/.maple/previews` : '.maple/previews';
}

export function previewArtifactPath(
  relDir: string,
  filename: string,
  format: PreviewCacheFormat,
): string {
  return `${previewCacheDir(relDir)}/${filename}.${PREVIEW_CACHE_FORMATS[format].extension}`;
}

export function previewIdentityPath(relDir: string, filename: string): string {
  return `${previewArtifactPath(relDir, filename, 'avif')}.source.json`;
}

export function previewDescriptorPath(relDir: string, filename: string): string {
  return `${previewCacheDir(relDir)}/${filename}.preview.json`;
}

export function validPreviewSource(
  source: PreviewSourceIdentity | undefined,
): source is PreviewSourceIdentity {
  return !!source && Number.isFinite(source.size) && Number.isFinite(source.lastModified);
}

export function samePreviewSource(
  left: PreviewSourceIdentity,
  right: PreviewSourceIdentity,
): boolean {
  return left.size === right.size && left.lastModified === right.lastModified;
}

export function parsePreviewDescriptor(bytes: Uint8Array): PreviewCacheDescriptor | null {
  try {
    const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as PreviewCacheDescriptor;
    if (
      descriptor.version !== 1 ||
      !isPreviewCacheFormat(descriptor.format) ||
      PREVIEW_CACHE_FORMATS[descriptor.format].mimeType !== descriptor.mimeType ||
      !validPreviewSource(descriptor.source) ||
      !Number.isFinite(descriptor.artifactLastModified)
    ) {
      return null;
    }
    return descriptor;
  } catch {
    return null;
  }
}
