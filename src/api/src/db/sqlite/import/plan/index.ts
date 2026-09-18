/**
 * The import plan: every source collection, in the order it is read.
 *
 * ## Why the order still matters when foreign keys are off
 *
 * The bulk load runs with `PRAGMA foreign_keys = OFF`, because the source has a
 * genuine reference cycle the loader cannot order its way out of: a face points
 * at a person, and a person's cover points at an asset. One of the two has to
 * be written before its target exists, so the load defers enforcement and
 * `PRAGMA foreign_key_check` becomes the gate at the end instead.
 *
 * The order below is still the foreign-key order, because it makes that final
 * check meaningful. Almost every reference resolves naturally when the parents
 * are loaded first, so a violation the check reports is a real dangling
 * reference in the source — a face assigned to a deleted person, a location in
 * a library that was unregistered — rather than an artefact of the order rows
 * happened to arrive in.
 *
 * ## Collections deliberately not imported
 *
 * They are declared in `plan/coverage.ts`, one line and a reason each, and the
 * run refuses to start when the source holds a collection that is in neither
 * that list nor this plan. The list used to live here and was five entries
 * short of the truth, which nothing could catch by running the importer.
 */

import type { CollectionPlan } from '../types.ts';
import { assetsPlan } from './assets.ts';
import { AUTH_PLANS } from './auth.ts';
import { LIBRARY_PLANS } from './library.ts';
import { OPERATIONS_PLANS } from './operations.ts';

/**
 * Every plan, in execution order: the roots the rest of the graph points at,
 * then assets and their fan-out, then users, then the queues — which reference
 * both a library root and a user.
 */
export const IMPORT_PLAN: readonly CollectionPlan[] = [
  ...LIBRARY_PLANS,
  assetsPlan,
  ...AUTH_PLANS,
  ...OPERATIONS_PLANS,
];

export { DEFAULT_CHANGES_WINDOW } from './library.ts';
export {
  MANAGED_CERTIFICATES_WARNING,
  SKIPPED_COLLECTIONS,
  uncoveredCollections,
  uncoveredMessage,
} from './coverage.ts';
