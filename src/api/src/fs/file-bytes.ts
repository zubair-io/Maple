import fs from './mirrored.ts';

/** True when both files exist and hold byte-identical content. Compares size
 * first (cheap), then streams a chunked byte comparison so we never hold a
 * whole RAW in memory. Any IO error other than a plain size mismatch
 * propagates — we must not silently treat an unreadable file as "different"
 * and then clobber it. */
export async function filesIdentical(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  if (sa.size === 0) return true;
  const fha = await fs.open(a, 'r');
  try {
    const fhb = await fs.open(b, 'r');
    try {
      const CHUNK = 64 * 1024;
      const bufA = Buffer.allocUnsafe(CHUNK);
      const bufB = Buffer.allocUnsafe(CHUNK);
      let pos = 0;
      while (pos < sa.size) {
        const [ra, rb] = await Promise.all([
          fha.read(bufA, 0, CHUNK, pos),
          fhb.read(bufB, 0, CHUNK, pos),
        ]);
        if (ra.bytesRead !== rb.bytesRead) return false; // truncated under us
        if (ra.bytesRead === 0) break;
        if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) {
          return false;
        }
        pos += ra.bytesRead;
      }
      return true;
    } finally {
      await fhb.close();
    }
  } finally {
    await fha.close();
  }
}
