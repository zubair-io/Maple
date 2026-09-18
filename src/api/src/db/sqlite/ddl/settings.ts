/**
 * The tables the initial schema (#3743) did not model.
 *
 * This file belongs to the remaining-collections port (#3751 / PR #3763),
 * which enumerates five such collections and corrects a sixth. Only the one
 * table the importer needs is carried here, and it is carried verbatim, so
 * that the importer branch is testable before #3763 lands. When #3763 merges,
 * its version of this file is the one to keep — it is a strict superset and it
 * owns this ground.
 *
 * ## Why `app_settings` is one JSON column and nothing else
 *
 * Every other table in this schema follows the rule that a field a query
 * filters on is a column. `app_settings` is the one place that rule does not
 * apply, because nothing ever filters it: all twenty-odd call sites read one
 * document by its id and write a flat `$set` back. The documents themselves
 * have nothing in common — the observability row holds an OTLP endpoint, the
 * describe row holds a model name and a daily spend cap, the migration row
 * holds a map of per-migration enable flags — so columns would mean either one
 * table per settings domain or a wide table of mutually exclusive nullable
 * fields that every new knob has to migrate.
 *
 * A single JSON document per id keeps the storage as boring as the access
 * pattern, and SQLite's `json_set` makes the partial update atomic rather than
 * a read-modify-write: `json_set(doc, '$.migrations.refile.enabled', json(?))`
 * creates the intermediate objects it needs, which is exactly what a dotted
 * Mongo `$set` path did.
 */

/**
 * Operator-tunable configuration, one JSON document per settings domain.
 *
 * The id is the same string the Mongo `_id` held — `enrichment`, `network`,
 * `observability`, `migration`, `missing-reaper` and so on — so a row keeps
 * the name the settings page, the route and the repo module already use.
 */
export const APP_SETTINGS_TABLE_DDL = `
CREATE TABLE app_settings (
  id  TEXT NOT NULL PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
) WITHOUT ROWID;
`;
