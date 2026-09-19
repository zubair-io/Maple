/**
 * What MongoDB says each of the asset's eight destination tables should hold.
 *
 * "The import finished" and "the import is correct" are different claims, and
 * this module supplies the evidence for the second one on the side of the fan-
 * out that a plain `countDocuments` cannot reach: one source document becomes a
 * variable number of location, face, link and stage rows, so the expected count
 * has to be an aggregation over the source rather than a document count.
 *
 * Every pipeline here is written to agree with `assets.ts` BY CONSTRUCTION
 * rather than by coincidence — the detail-row predicate is the same field list,
 * the link count applies the same skip-and-deduplicate rule, and the stage
 * count unions the same canonical names. A count check that quietly re-derives
 * the rule a second, subtly different way is worse than no check at all,
 * because it reports agreement about the wrong question.
 */

import type { Db, Document, Filter } from 'mongodb';
import { DETAIL_SOURCE_FIELDS, ENRICHMENT_STAGES } from './asset-fields.ts';
import { locationEntryStages } from './contested-locations.ts';

/** Runs a `$group`-to-one pipeline and reads the single `total` back. */
async function total(db: Db, filter: Filter<Document>, perDocument: Document): Promise<number> {
  const rows = await db
    .collection('assets')
    .aggregate<{ total: number }>([
      { $match: filter },
      { $project: { n: perDocument } },
      { $group: { _id: null, total: { $sum: '$n' } } },
    ])
    .toArray();
  return rows[0]?.total ?? 0;
}

/**
 * `$objectToArray` guarded against a field that is absent or not an object.
 *
 * `$cond` is spelled in its three-element array form rather than as
 * `{ if, then, else }` because an object literal with a `then` key is a
 * thenable, and a thenable that reaches an `await` behaves in ways nothing here
 * intends.
 */
function objectKeys(path: string): Document {
  return {
    $cond: [
      { $eq: [{ $type: path }, 'object'] },
      { $map: { input: { $objectToArray: path }, as: 'e', in: '$$e.k' } },
      [],
    ],
  };
}

/**
 * Locations: one row per distinct `(library_id, path, filename)` the source's
 * usable entries name.
 *
 * Not one row per usable entry, which is what this counted until #3790. The
 * destination's `asset_locations_lib_path_name` is UNIQUE over that triple, so
 * an address more than one entry claims becomes ONE row and the entries that
 * lost it are released — the number of rows the destination should hold is
 * therefore the number of addresses, and that is what is counted here.
 *
 * Stated against the source rather than by subtracting a tally the importer
 * kept, which is the stronger of the two: it needs no bookkeeping to survive a
 * resumed run, and an importer that released a row it should have written
 * fails this check instead of agreeing with its own record of having done so.
 * The entry-level stages are shared with the resolution itself, so the two
 * cannot disagree about what an address is.
 */
async function locationCount(db: Db, filter: Filter<Document>): Promise<number> {
  const rows = await db
    .collection('assets')
    .aggregate<{ total: number }>(
      [...locationEntryStages(filter), { $group: { _id: '$address' } }, { $count: 'total' }],
      { allowDiskUse: true },
    )
    .toArray();
  return rows[0]?.total ?? 0;
}

/**
 * Links, after the two rules `phassetRows` applies: an entry missing either
 * half of the device/local-id pair is skipped, and a pair repeated within one
 * asset lands as a single row because the table's UNIQUE constraint is stronger
 * than the array was.
 */
function linkCount(): Document {
  const usable = {
    $filter: {
      input: { $ifNull: ['$phasset_links', []] },
      as: 'l',
      cond: {
        $and: [
          { $gt: [{ $strLenCP: { $ifNull: ['$$l.device_id', ''] } }, 0] },
          { $gt: [{ $strLenCP: { $ifNull: ['$$l.phasset_local_id', ''] } }, 0] },
        ],
      },
    },
  };
  return {
    $size: {
      $setUnion: [
        {
          $map: {
            input: usable,
            as: 'l',
            in: { $concat: ['$$l.device_id', '\u0000', '$$l.phasset_local_id'] },
          },
        },
      ],
    },
  };
}

/** Expected row counts for every table the asset plan writes into. */
export async function assetExpectedCounts(
  db: Db,
  filter: Filter<Document>,
  stageNames: readonly string[],
): Promise<Record<string, number>> {
  const assets = db.collection('assets');

  const detailFilter: Filter<Document> = {
    $and: [filter, { $or: DETAIL_SOURCE_FIELDS.map((field) => ({ [field]: { $ne: null } })) }],
  };
  const searchFilter: Filter<Document> = {
    $and: [filter, { search_blob: { $type: 'string', $ne: '' } }],
  };

  const [assetCount, locations, links, faces, detail, search, stages, enrichment] =
    await Promise.all([
      assets.countDocuments(filter),
      locationCount(db, filter),
      total(db, filter, linkCount()),
      total(db, filter, { $size: { $ifNull: ['$faces', []] } }),
      assets.countDocuments(detailFilter),
      assets.countDocuments(searchFilter),
      total(db, filter, { $size: { $setUnion: [stageNames, objectKeys('$stages')] } }),
      total(db, filter, {
        $size: {
          $setIntersection: [
            ENRICHMENT_STAGES,
            {
              $cond: [
                { $eq: [{ $type: '$enrichment' }, 'object'] },
                {
                  $map: {
                    input: {
                      $filter: {
                        input: { $objectToArray: '$enrichment' },
                        as: 'e',
                        cond: { $ne: ['$$e.v', null] },
                      },
                    },
                    as: 'e',
                    in: '$$e.k',
                  },
                },
                [],
              ],
            },
          ],
        },
      }),
    ]);

  return {
    assets: assetCount,
    asset_locations: locations,
    asset_phasset_links: links,
    faces,
    asset_detail: detail,
    asset_search: search,
    stage_state: stages,
    enrichment_state: enrichment,
  };
}
