/**
 * Online face clustering — the operator-triggered (or scheduled) pass that
 * groups face embeddings into people.
 *
 * For each unassigned face, find the nearest centroid under cosine similarity.
 * If the best score >= `similarityThreshold`, assign the face to that person;
 * otherwise create a new auto-named "Person N" and seed its centroid with the
 * face's embedding. Idempotent: re-running over unchanged data assigns nothing.
 *
 * Centroids are the L2-normalised mean of a person's assigned face embeddings,
 * which is what collapses cosine similarity to a dot product.
 *
 * The write side lives in `db/repos/people.clustering-job.ts` and the
 * load + compute stage it dispatches to lives in `people.cluster-load.ts`,
 * running on the clustering worker. This module is the stable import path for
 * the route, the coordinator and the tests.
 */

export { backfillCoverAssets, runOnlineClustering } from '../db/repos/people.clustering-job.ts';
export type {
  RunOnlineClusteringOptions,
  RunOnlineClusteringResult,
} from '../db/repos/people.clustering-job.ts';

// The pure-function clustering core. Callers that only need the math prefer
// importing `./cluster-embeddings.ts` directly, so the quality harness can pull
// it in without dragging a database along; these re-exports exist because the
// constants and helpers used to live in this file.
export {
  clusterEmbeddings,
  DEFAULT_SIMILARITY_THRESHOLD,
  dotProduct,
  l2Normalise,
  updateCentroid,
} from './cluster-embeddings.ts';
export type {
  ClusterSeed,
  OnlineClusterOptions,
  OnlineClusterResult,
} from './cluster-embeddings.ts';

// `recomputeCentroids` runs on the worker as part of the load stage, but stays
// part of this module's public surface — the route and the tests import it
// from here.
