import type { RemovalSidecarSnapshot } from './removal-server-io.service';

/** A transport acknowledgement must name the exact UTF-8 document we sent. */
export async function confirmedSidecarRevision(
  xml: string,
  saved: RemovalSidecarSnapshot,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml)),
  );
  const revision = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (saved.xml !== xml || saved.revision !== revision)
    throw new Error('Removal sidecar confirmation did not match the saved document.');
  return revision;
}
