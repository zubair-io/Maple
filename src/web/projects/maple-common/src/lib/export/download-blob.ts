// Browser download trigger (#943).
//
// There was no download helper in the codebase before export — every prior
// `createObjectURL` use is blob-URL caching for display. This is the one place
// that hands a file to the browser.

/**
 * How long to keep the object URL alive after the click.
 *
 * Revoking synchronously (or on the next microtask) races the browser's own
 * fetch of the URL and can cancel the download outright, which is a
 * particularly nasty failure for a multi-hundred-megabyte export. A generous
 * delay costs one retained blob reference; the blob is browser-managed
 * storage, not JS heap, so this is not a memory-pressure risk.
 */
const REVOKE_DELAY_MS = 60_000;

/**
 * Offer `blob` to the user as a download named `filename`.
 *
 * This writes NOTHING to the library — the browser routes it to the user's
 * download location. Originals are never touched.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
