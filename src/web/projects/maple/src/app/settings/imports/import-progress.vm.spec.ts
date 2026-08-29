// Tests for the shared import completion-rate helper.
//
// The cases here are the ones plain `current / total` gets wrong: a finished
// job that must read 100%, a stopped job that must NOT, an empty file list,
// and a stale counter from a re-scan.

import { describe, it, expect } from 'vitest';
import type { ImportStatus } from '@maple-common';
import { importPercent } from './import-progress.vm';

const job = (status: ImportStatus, current: number, total: number) => ({
  status,
  progress: { current, total },
});

describe('importPercent', () => {
  it('reports the ratio while a job is running', () => {
    expect(importPercent(job('running', 25, 100))).toBe(25);
    expect(importPercent(job('running', 1, 3))).toBe(33);
    expect(importPercent(job('pending', 0, 10))).toBe(0);
  });

  it('reports 100 for a finished job, whatever the counters say', () => {
    expect(importPercent(job('done', 99, 100))).toBe(100);
    // A job whose scan produced no files still finished — 0/0 must not
    // render as 0%.
    expect(importPercent(job('done', 0, 0))).toBe(100);
  });

  it('keeps the real ratio for a job that stopped early', () => {
    expect(importPercent(job('cancelled', 40, 100))).toBe(40);
    expect(importPercent(job('failed', 12, 100))).toBe(12);
  });

  it('clamps a stale counter into range', () => {
    // A retry re-scan rewrites `total` wholesale; a `current` left over from
    // the previous attempt must never render a bar past full.
    expect(importPercent(job('running', 800, 5))).toBe(100);
    expect(importPercent(job('running', -1, 10))).toBe(0);
  });

  it('reports 0 before the file list exists', () => {
    // Auto Import between queue and the worker's deferred scan.
    expect(importPercent(job('pending', 0, 0))).toBe(0);
    expect(importPercent(null)).toBe(0);
  });
});
