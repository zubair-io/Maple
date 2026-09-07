import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Stream large read-only originals instead of duplicating the RAW in memory. */
export async function hashFixture(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
