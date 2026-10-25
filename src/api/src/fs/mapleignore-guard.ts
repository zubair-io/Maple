/**
 * The `.mapleignore` disk guard for writers that hold only an absolute path
 * (#5398): sidecar writes and deletes, `.hidden` sibling markers, Trash
 * purges. It walks every ancestor of the file up to the filesystem root, so
 * it needs neither the library table nor a location's tag, and a lookup
 * failure cannot switch it off. Maple's own `.maple/` tree (Trash, caches) is
 * never under the guard, so a marker at a library root cannot strand Trash.
 */
import * as path from 'node:path';
import { ignoreVerdictForFile } from './mapleignore.ts';

/** True unless `absPath` is verifiably not under a marker. */
export async function refusesFileUnderMarker(absPath: string): Promise<boolean> {
  const resolved = path.resolve(absPath);
  if (resolved.split(path.sep).includes('.maple')) return false;
  return (await ignoreVerdictForFile(path.parse(resolved).root, resolved)) !== 'indexed';
}
