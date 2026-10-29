import { utimes, writeFile } from '../fs/mirrored.ts';

/** Write `bytes` with an mtime two hours back: a truncated original only
 * counts as damaged once it has stopped changing (#5513). */
export async function writeSettledFile(file: string, bytes: string | Uint8Array): Promise<void> {
  await writeFile(file, bytes);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(file, twoHoursAgo, twoHoursAgo);
}
