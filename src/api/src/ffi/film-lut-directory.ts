import { resolve } from 'node:path';
import { stat } from '../fs/mirrored.ts';

/** Shipped LUTs are shared by authored cache regeneration and recipe exports. */
export async function filmLutDirectory(): Promise<string> {
  const local = resolve(import.meta.dir, '../../../../resources/film-luts');
  return stat(local)
    .then(() => local)
    .catch(() => resolve(import.meta.dir, '../../film-luts'));
}
