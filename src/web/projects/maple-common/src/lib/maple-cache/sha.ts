// SHA-256 helper using browser-native crypto.subtle.
// Used to derive the stable filename-based cache key for the .maple/ protocol.
// Key derivation: sha256(filename)[:16] as hex.

/**
 * Returns the full SHA-256 digest of `text` as a lowercase hex string.
 * Uses crypto.subtle — available in all modern browsers and Node ≥ 15.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Returns the first 16 hex characters of sha256(text).
 * This is the cache-key stem used in `.maple/thumbs/<sha>.avif` (or `.jpg`
 * for legacy/pre-AVIF-migration cached entries — see `MapleCacheService`).
 * Same derivation is used by Maple Self Hosted and Maple native — do not change.
 */
export async function sha256Prefix16(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}
