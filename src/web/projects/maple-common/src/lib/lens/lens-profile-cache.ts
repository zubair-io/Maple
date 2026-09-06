import { openDb, reqToPromise, txDone } from '../util/idb';

const STORE = 'profiles';
export function lensProfileDigest(reference: string): string {
  const digest = /^lcp1(?:-ack)?:([a-f0-9]{64})$/.exec(reference)?.[1];
  if (!digest) throw new Error('Unsupported lens profile reference');
  return digest;
}

async function open(): Promise<IDBDatabase> {
  return openDb('maple-lens-profiles', 1, (db) => db.createObjectStore(STORE));
}

/** The persisted XML is byte-for-byte the imported string. The core verifies
 * its digest on every process-cache restore before any image is rendered. */
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
