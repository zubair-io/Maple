// RAW-format detection — the single source of truth for which file
// extensions are RAW (decoded by the Rust/WASM pipeline) vs non-RAW
// (developed images decoded browser-natively; see image-utils.ts).
//
// Kept dependency-free and standalone so any layer can import it without
// pulling in the heavy `library-fetch.service` graph (which would create an
// import cycle for the raw-pipeline service). `library-fetch.service` and
// `library-state.service` re-export these for their existing public surface.

/** Supported RAW extensions for file intake. */
export const SUPPORTED_RAW_EXTENSIONS = new Set([
  'dng',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'raf',
  'orf',
  'rw2',
  'pef',
  'srw',
  'x3f',
  '3fr',
  'mef',
  'fff',
  'dcr',
  'mos',
  'iiq',
  'mrw',
  'raw',
]);

export function isSupportedRaw(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_RAW_EXTENSIONS.has(ext);
}

/** True when `ext` (already lowercased, no dot) is a non-RAW developed image. */
export function isNonRawExtension(ext: string): boolean {
  return !SUPPORTED_RAW_EXTENSIONS.has(ext.toLowerCase());
}
