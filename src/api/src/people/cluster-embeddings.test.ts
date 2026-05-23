/**
 * Unit tests for the pure `clusterEmbeddings` core extracted from
 * `runOnlineClustering`. No Mongo — these mirror the DB-backed test
 * scenarios in `clustering-job.test.ts` so the refactor stays parity-safe.
 */

import { describe, it, expect } from 'bun:test';
import { clusterEmbeddings } from './cluster-embeddings.ts';

const DIM = 512;

function unitVector(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

function nearAxis(axis: number, jitter: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1 - jitter;
  v[(axis + 1) % DIM] = jitter / 2;
  v[(axis + 2) % DIM] = jitter / 2;
  return v;
}

describe('clusterEmbeddings', () => {
  it('assigns close faces to one cluster (same behaviour as DB-backed path)', () => {
    const result = clusterEmbeddings([nearAxis(0, 0.05), nearAxis(0, 0.1), nearAxis(0, 0.15)]);
    expect(result.assignments).toEqual([0, 0, 0]);
    expect(result.newClusters).toBe(1);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].face_count).toBe(3);
  });

  it('opens a new cluster for a far face', () => {
    const result = clusterEmbeddings([nearAxis(0, 0.05), nearAxis(50, 0.05)]);
    // Two orthogonal axes → second face creates its own cluster.
    expect(result.assignments).toEqual([0, 1]);
    expect(result.newClusters).toBe(2);
  });

  it('respects an explicit similarity threshold', () => {
    // With threshold 0.999, even small-jitter near-duplicates split into
    // new clusters because cosine ≈ 0.95 isn't enough.
    const result = clusterEmbeddings([nearAxis(0, 0.05), nearAxis(0, 0.5)], {
      similarityThreshold: 0.999,
    });
    expect(result.newClusters).toBe(2);
  });

  it('seeds from prior clusters and reuses them', () => {
    // Seed cluster around axis 7; new embedding near axis 7 should reuse it.
    const seedCentroid = unitVector(7);
    const result = clusterEmbeddings([nearAxis(7, 0.05)], {
      seeds: [{ centroid: seedCentroid, face_count: 3 }],
    });
    expect(result.assignments[0]).toBe(0);
    expect(result.reusedSeed[0]).toBe(true);
    expect(result.newClusters).toBe(0);
    // face_count incremented on the streaming mean.
    expect(result.clusters[0].face_count).toBe(4);
  });

  it('streams the centroid mean (does not snap to last-seen embedding)', () => {
    // Three near-axis-0 faces; the running mean's primary axis should
    // stay at 0 and the per-cell mean should shrink as jitter is averaged.
    const result = clusterEmbeddings([nearAxis(0, 0.0), nearAxis(0, 0.0), nearAxis(0, 0.0)]);
    expect(result.clusters[0].face_count).toBe(3);
    // Argmax of centroid is axis 0.
    let maxIdx = 0;
    for (let i = 1; i < DIM; i += 1) {
      if (result.clusters[0].centroid[i] > result.clusters[0].centroid[maxIdx]) maxIdx = i;
    }
    expect(maxIdx).toBe(0);
  });

  it('returns empty result for empty input', () => {
    const result = clusterEmbeddings([]);
    expect(result.assignments).toEqual([]);
    expect(result.newClusters).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it('does not mutate the caller-provided seed array', () => {
    const seedArr = [{ centroid: unitVector(3), face_count: 5 }];
    const before = seedArr[0].face_count;
    clusterEmbeddings([nearAxis(3, 0.05)], { seeds: seedArr });
    expect(seedArr[0].face_count).toBe(before);
  });
});
