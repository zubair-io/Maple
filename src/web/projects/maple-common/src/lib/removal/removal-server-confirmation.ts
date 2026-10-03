import type { RemovalSidecarSnapshot } from './removal-server-io.service';

/** A transport acknowledgement must name the exact UTF-8 document we sent. */
export async function confirmedSidecarRevision(
  xml: string,
  saved: RemovalSidecarSnapshot,
): Promise<string> {
  const revision = await removalSidecarRevision(xml);
  if (saved.xml !== xml || saved.revision !== revision)
    throw new Error('Removal sidecar confirmation did not match the saved document.');
  return revision;
}

export async function removalSidecarRevision(xml: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
