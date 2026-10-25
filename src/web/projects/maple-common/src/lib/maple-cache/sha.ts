// SHA-256 helper using browser-native crypto.subtle.
// Derives the filename hash stem of the legacy .maple/ thumb name.
// Key derivation: sha256(filename)[:16] as hex.

/**
 * Returns the full SHA-256 digest of `text` as a lowercase hex string.
 * Uses crypto.subtle — available in all modern browsers and Node ≥ 15.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256BytesHex(bytes);
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Returns the first 16 hex characters of sha256(text).
 * Thumbs are now `.maple/thumbs/<filename>.avif` (#4793); this stem survives
 * only to find the frozen legacy `<sha>.v25.<ext>` thumb and for the
 * `sha256Prefix` field of index.json. Same derivation as Maple Self Hosted and
 * Maple native — do not change.
 */
export async function sha256Prefix16(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}
