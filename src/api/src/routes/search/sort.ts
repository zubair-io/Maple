/**
 * Sort-spec selection for `/api/search`. The `sort` query parameter is
 * validated against `SORT_OPTIONS`; unknown values fall back to
 * `captured_desc`. Every key includes `_id` as the final tiebreak so
 * pagination is stable when many assets share the same timestamp
 * (e.g. burst frames).
 */

import type { Sort } from "mongodb";

export const SORT_OPTIONS = new Set([
  "captured_desc",
  "captured_asc",
  "name",
  "rating",
]);

export function pickSort(sort: string | undefined): Sort {
  switch (sort) {
    case "captured_asc":
      return { "exif.captured_at": 1, _id: 1 };
    case "name":
      // Post drop-abs-path-2026-05-21 the canonical filename lives on
      // `fileinfo[0].filename`; pre-PR-7 it was the top-level
      // `filename` field. Sort on the primary fileinfo entry to keep
      // the wire semantics ("alphabetical by name").
      return { "fileinfo.0.filename": 1, _id: 1 };
    case "rating":
      return { rating: -1, "exif.captured_at": -1, _id: 1 };
    case "captured_desc":
    default:
      return { "exif.captured_at": -1, _id: 1 };
  }
}
