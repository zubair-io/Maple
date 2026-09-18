/**
 * `GET /api/search` on SQLite: one page of the grid, and the total beside it.
 *
 * ## Why the two live in one file
 *
 * A search response carries a page of results and a count of everything that
 * matched, and the failure mode when those disagree is not subtle — the grid
 * shows "1,482 photos" above an empty scroller. The Meilisearch branch produced
 * exactly that once, by post-filtering a single page and reporting a count from
 * a different predicate. Here {@link searchPage} and {@link searchCount} take
 * the same translated {@link SearchWhere} and compose it the same way, so the
 * predicate is not something the two can differ on; the seek predicate and the
 * limit are the only things the page adds, and neither can shrink a count.
 *
 * ## What a page returns
 *
 * `AssetDoc`-shaped rows, not wire results. `projectAsset` in
 * `routes/search/project.ts` is unchanged and keeps doing the projection, so
 * the wire shape cannot drift from the Mongo path during the cutover — and
 * `cursorFromDoc` keeps working on the last row of the page for free.
 *
 * Four statements per page. The first decides *which* assets; the other three
 * fill in the locations, the caption and the PhotoKit links for exactly those
 * ids. That ordering is the semi-join rule again: nothing after the first query
 * can widen or narrow the result set.
 */

import { ObjectId } from 'mongodb';
import type { AssetDoc, AssetExif, Place } from '../../schema.ts';
import { groupByAsset, json, toFileInfo, type LocationRow } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';
import {
  countSql,
  descriptionsByAssetIdsSql,
  pageSql,
  phassetLinksByAssetIdsSql,
  seekPredicate,
} from './search.sql.ts';
import type { SearchWhere } from './search.where.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';

/** The narrow `assets` projection a search result is built from. */
interface PageRow {
  id: string;
  size: number;
  mtime: number;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  has_xmp: number;
  hidden: number;
  exif: string | null;
  place: string | null;
}

interface DescriptionRow {
  asset_id: string;
  description: string | null;
}

interface LinkRow {
  asset_id: string;
  device_id: string;
  phasset_local_id: string;
  phasset_cloud_id: string | null;
  first_seen: string;
}

/** The cursor shape `routes/search/cursor.ts` decodes and validates. */
export interface SeekPosition {
  v: string | null;
  i: string;
  d: 'asc' | 'desc';
}

/** How a page is addressed: a sort, a size, and either a skip or a cursor. */
export interface PageOptions {
  sort: string;
  limit: number;
  /** Rows to skip. Ignored when a cursor is present — a seek replaces it. */
  skip: number;
  cursor?: SeekPosition | null;
}

/**
 * How many assets match — the `total` on the response.
 *
 * Counts the same `FROM` and `WHERE` the page query builds, which is what makes
 * the two agree by construction rather than by review.
 */
export async function searchCount(where: SearchWhere, dbOverride?: SqliteDb): Promise<number> {
  const statement = countSql(where);
  const rows = await assetsDb(dbOverride).read<{ n: number }>(statement.sql, statement.params);
  return rows[0]?.n ?? 0;
}

/**
 * One page of matching assets, newest first unless another sort was asked for.
 *
 * A cursor replaces the skip rather than adding to it: the seek predicate
 * already positions the scan after the previous page's last row, so any offset
 * on top would silently drop that many results.
 */
export async function searchPage(
  where: SearchWhere,
  options: PageOptions,
  dbOverride?: SqliteDb,
): Promise<Array<AssetDoc & { _id: ObjectId }>> {
  const db = assetsDb(dbOverride);
  const seek = options.cursor ? seekPredicate(options.cursor) : undefined;
  const statement = pageSql(where, options.sort, options.limit, seek ? 0 : options.skip, seek);
  const rows = await db.read<PageRow>(statement.sql, statement.params);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [locations, descriptions, links] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids),
    db.read<DescriptionRow>(descriptionsByAssetIdsSql(ids.length), ids),
    db.read<LinkRow>(phassetLinksByAssetIdsSql(ids.length), ids),
  ]);

  const locationsByAsset = groupByAsset(locations);
  const linksByAsset = groupByAsset(links);
  const captions = new Map(descriptions.map((row) => [row.asset_id, row.description] as const));

  return rows.map((row) => toAssetDoc(row, locationsByAsset, linksByAsset, captions));
}

/**
 * One row plus its side tables, as the document shape `projectAsset` reads.
 *
 * `first_seen` comes back as the ISO string the column stores and becomes a
 * `Date`, which is what the BSON field held and what the type declares. The
 * projection drops it, along with `device_id`, on the way to the wire — but a
 * document that is only half a document is the kind of shortcut that works
 * until some other caller reads the field, so the shape is complete.
 */
function toAssetDoc(
  row: PageRow,
  locations: ReadonlyMap<string, LocationRow[]>,
  links: ReadonlyMap<string, LinkRow[]>,
  captions: ReadonlyMap<string, string | null>,
): AssetDoc & { _id: ObjectId } {
  const linkRows = links.get(row.id) ?? [];
  return {
    _id: new ObjectId(row.id),
    fileinfo: toFileInfo(locations.get(row.id) ?? []),
    size: row.size,
    mtime: row.mtime,
    indexed_at: row.indexed_at,
    rating: row.rating,
    flag: row.flag as -1 | 0 | 1,
    color_label: row.color_label,
    has_xmp: row.has_xmp === 1,
    hidden: row.hidden === 1,
    exif: json<AssetExif>(row.exif),
    place: json<Place>(row.place),
    description: captions.get(row.id) ?? null,
    phasset_links: linkRows.map((link) => ({
      device_id: link.device_id,
      phasset_local_id: link.phasset_local_id,
      ...(link.phasset_cloud_id === null ? {} : { phasset_cloud_id: link.phasset_cloud_id }),
      first_seen: new Date(link.first_seen),
    })),
  };
}
