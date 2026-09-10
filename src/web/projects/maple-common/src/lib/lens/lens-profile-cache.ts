// Browser-side store for imported LCP bytes (#3479) — IndexedDB
// `maple-lens-profiles`, keyed by the BLAKE3 digest the sidecar reference
// carries. Hosted's only copy; Self Hosted's local mirror of the server
// cache. Tabulated in docs/caching.md. Runs on the render worker (import +
// restore) and, for Self Hosted, on the main thread (server restore).

import { openDb, reqToPromise, txDone } from '../util/idb';

const DB_NAME = 'maple-lens-profiles';
const STORE = 'profiles';

/**
 * The digest a `papp:LensProfile` reference names. `lcp1` pins Maple's
 * interpretation of the document; `-ack` records approximation acceptance
 * and names the same bytes. Anything else is a future version this build
 * cannot supply — the core reports it at render time.
 */
export function lensProfileDigest(reference: string): string {
  const digest = /^lcp1(?:-ack)?:([a-f0-9]{64})$/.exec(reference)?.[1];
  if (!digest) throw new Error(`Unsupported lens profile reference: ${reference}`);
  return digest;
}

function open(): Promise<IDBDatabase> {
  return openDb(DB_NAME, 1, (db) => db.createObjectStore(STORE));
}

/** Persist the exact imported document. The core re-verifies its digest on
 * every restore, so a corrupt row can never register under this reference. */
export async function cacheLensProfile(reference: string, xml: string): Promise<void> {
  const digest = lensProfileDigest(reference);
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(xml, digest);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function cachedLensProfile(reference: string): Promise<string | undefined> {
  const digest = lensProfileDigest(reference);
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const result: unknown = await reqToPromise(tx.objectStore(STORE).get(digest));
    return typeof result === 'string' ? result : undefined;
  } finally {
    db.close();
  }
}
