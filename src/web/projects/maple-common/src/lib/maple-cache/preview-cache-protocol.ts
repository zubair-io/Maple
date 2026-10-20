import {
  isPreviewCacheFormat,
  PREVIEW_CACHE_FORMATS,
  type PreviewCacheFormat,
} from './cache-image-format';

/** Shared derivatives are unversioned (#4793). The only other layout a client
 * ever probes is this one frozen name segment, written for a short window as
 * `<name>.v25.<ext>`; it must never track the develop pipeline output. */
export const LEGACY_DERIVATIVE_SEGMENT = '.v25';

export type DerivativeNaming = '' | typeof LEGACY_DERIVATIVE_SEGMENT;

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
  naming: DerivativeNaming = '',
): string {
  return `${previewCacheDir(relDir)}/${filename}${naming}.${PREVIEW_CACHE_FORMATS[format].extension}`;
}

export function previewIdentityPath(
  relDir: string,
  filename: string,
  naming: DerivativeNaming = '',
): string {
  return `${previewArtifactPath(relDir, filename, 'avif', naming)}.source.json`;
}

export function previewDescriptorPath(
  relDir: string,
  filename: string,
  naming: DerivativeNaming = '',
): string {
  return `${previewCacheDir(relDir)}/${filename}${naming}.preview.json`;
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
