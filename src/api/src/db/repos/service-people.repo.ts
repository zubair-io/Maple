/**
 * `GET /api/service/people`: the visible people who appear in the key owner's visible photos.
 *
 * People are library-wide rows, so a person is listed only through the owner's own photos: the
 * count is of those photos, and the cover is the person's chosen cover only when it is one of them
 * (otherwise their newest such photo), so no asset id of another user ever leaves this module.
 */

import { AUTO_PERSON_NAME } from '../../people/auto-person-name.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';
import { searchWhereSql, type SearchWhere } from './search.where.ts';

export interface ServicePerson {
  id: string;
  name: string;
  autoNamed: boolean;
  photoCount: number;
  coverAssetId: string | null;
}

interface PersonCountRow {
  id: string;
  name: string;
  cover_asset_id: string | null;
  cover_visible: number;
  newest: string;
  photo_count: number;
}

/** Named people first, then by how many photos they are in, then by name. */
function byPresence(a: ServicePerson, b: ServicePerson): number {
  return (
    Number(a.autoNamed) - Number(b.autoNamed) ||
    b.photoCount - a.photoCount ||
    a.name.localeCompare(b.name)
  );
}

export async function listServicePeople(
  scope: SearchWhere,
  db?: SqliteDb,
): Promise<ServicePerson[]> {
  const bound = searchWhereSql(scope, {
    sql: 'p.merged_into IS NULL AND p.hidden = 0 AND p.excluded = 0',
    params: [],
  });
  const rows = await readBulk<PersonCountRow>(
    assetsDb(db),
    `SELECT p.id AS id, p.name AS name, p.cover_asset_id AS cover_asset_id,
            MAX(assets.id = p.cover_asset_id) AS cover_visible,
            MAX(assets.captured_at || '|' || assets.id) AS newest,
            COUNT(DISTINCT assets.id) AS photo_count
       FROM assets
       JOIN faces pf ON pf.asset_id = assets.id AND pf.hidden = 0
       JOIN people p ON p.id = pf.person_id
       ${bound.sql}
      GROUP BY p.id`,
    bound.params,
  );
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      autoNamed: AUTO_PERSON_NAME.test(row.name),
      photoCount: row.photo_count,
      coverAssetId:
        row.cover_visible === 1 ? row.cover_asset_id : (row.newest.split('|')[1] ?? null),
    }))
    .sort(byPresence);
}
