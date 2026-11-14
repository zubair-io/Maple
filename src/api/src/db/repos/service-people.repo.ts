/**
 * `GET /api/service/people`: the visible people who appear in the key owner's visible photos.
 *
 * People are library-wide rows, so a person is listed only through the owner's own photos: the
 * count is of those photos, and the cover is the person's chosen cover only when it is one of them
 * (otherwise their newest such photo), so no asset id of another user ever leaves this module. A
 * chosen cover that is a stack's JPEG folded into its RAW is served as that RAW.
 *
 * Counts follow the search's RAW+JPEG fold for that one person: a stack's JPEG counts on its own
 * when its RAW does not show them, and folds into the RAW when it does, so a person's count is the
 * `total` a search for them alone answers.
 */

import { AUTO_PERSON_NAME } from '../../people/auto-person-name.ts';
import { assetsDb, readBulk, type SqliteDb } from './db-handle.ts';
import { searchWhereSql, stackFold, type SearchWhere } from './search.where.ts';

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
  cover: string | null;
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

/** The row's asset shows the person of the outer `p`; the fold reads it again for the RAW. */
const SHOWS_PERSON = `EXISTS (SELECT 1 FROM faces sf
  WHERE sf.asset_id = assets.id AND sf.person_id = p.id AND sf.hidden = 0)`;

export async function listServicePeople(
  scope: SearchWhere,
  db?: SqliteDb,
): Promise<ServicePerson[]> {
  const unfolded: SearchWhere = { ...scope, foldStacks: false };
  const bound = searchWhereSql(unfolded, {
    sql: 'p.merged_into IS NULL AND p.hidden = 0 AND p.excluded = 0',
    params: [],
  });
  // Whether this row counts for this person: false for a JPEG whose RAW shows them too.
  const counted = stackFold({
    ...unfolded,
    clauses: [...unfolded.clauses, SHOWS_PERSON],
    foldStacks: scope.foldStacks === true,
  }) ?? { sql: '1', params: [] };
  const rows = await readBulk<PersonCountRow>(
    assetsDb(db),
    `SELECT id, name, MAX(CASE WHEN counted AND is_cover THEN asset_id END) AS cover,
            MAX(CASE WHEN counted THEN newest END) AS newest,
            COUNT(DISTINCT CASE WHEN counted THEN asset_id END) AS photo_count
       FROM (SELECT p.id AS id, p.name AS name, assets.id AS asset_id,
                    assets.id IN (p.cover_asset_id, (SELECT chosen.stack_primary_id
                      FROM assets AS chosen WHERE chosen.id = p.cover_asset_id)) AS is_cover,
                    assets.captured_at || '|' || assets.id AS newest, ${counted.sql} AS counted
               FROM assets
               JOIN faces pf ON pf.asset_id = assets.id AND pf.hidden = 0
               JOIN people p ON p.id = pf.person_id
               ${bound.sql})
      GROUP BY id
     HAVING photo_count > 0`,
    [...counted.params, ...bound.params],
  );
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      autoNamed: AUTO_PERSON_NAME.test(row.name),
      photoCount: row.photo_count,
      coverAssetId: row.cover ?? row.newest.split('|')[1] ?? null,
    }))
    .sort(byPresence);
}
