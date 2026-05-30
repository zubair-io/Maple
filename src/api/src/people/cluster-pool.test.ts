/**
 * Parity tests for the off-thread clustering pool. The Worker must return
 * output bit-identical to the synchronous `clusterEmbeddings` core — moving
 * the pass off the main thread is a timing change only, never a result
 * change. These mirror the scenarios in `cluster-embeddings.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { clusterEmbeddings } from './cluster-embeddings.ts';
import { clusterEmbeddingsOffThread } from './cluster-pool.ts';

const DIM = 512;

function nearAxis(axis: number, jitter: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1 - jitter;
  v[(axis + 1) % DIM] = jitter / 2;
  v[(axis + 2) % DIM] = jitter / 2;
  return v;
}

function unitVector(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

describe('clusterEmbeddingsOffThread', () => {
  it('matches the synchronous core for a simple same-cluster batch', async () => {
    const embeddings = [nearAxis(0, 0.05), nearAxis(0, 0.1), nearAxis(0, 0.15)];
    const sync = clusterEmbeddings(embeddings, {});
    const off = await clusterEmbeddingsOffThread(embeddings, {});

    expect(off.assignments).toEqual(sync.assignments);
    expect(off.newClusters).toBe(sync.newClusters);
    expect(off.reusedSeed).toEqual(sync.reusedSeed);
    expect(off.clusters.map((c) => c.face_count)).toEqual(sync.clusters.map((c) => c.face_count));
  });

  it('matches the synchronous core when seeding from prior clusters', async () => {
    const embeddings = [nearAxis(7, 0.05), nearAxis(50, 0.05), nearAxis(7, 0.2)];
    const opts = { seeds: [{ centroid: unitVector(7), face_count: 3 }] };
    const sync = clusterEmbeddings(embeddings, opts);
    const off = await clusterEmbeddingsOffThread(embeddings, opts);

    expect(off.assignments).toEqual(sync.assignments);
    expect(off.newClusters).toBe(sync.newClusters);
    expect(off.reusedSeed).toEqual(sync.reusedSeed);
    // Centroids must come back as real Float32Arrays with matching values.
    expect(off.clusters).toHaveLength(sync.clusters.length);
    for (let k = 0; k < sync.clusters.length; k += 1) {
      expect(off.clusters[k].centroid).toBeInstanceOf(Float32Array);
      expect(Array.from(off.clusters[k].centroid)).toEqual(Array.from(sync.clusters[k].centroid));
    }
  });

  it("does not detach the caller's embedding buffers (structured-clone, not transfer)", async () => {
    const embeddings = [nearAxis(3, 0.05), nearAxis(3, 0.1)];
    await clusterEmbeddingsOffThread(embeddings, {});
    // If the pool transferred the buffers, these would be detached (length 0).
    expect(embeddings[0].length).toBe(DIM);
    expect(embeddings[1].length).toBe(DIM);
    expect(embeddings[0][3]).toBeCloseTo(1 - 0.05, 5);
  });
});
