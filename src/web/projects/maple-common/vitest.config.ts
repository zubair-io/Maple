import { defineConfig } from 'vitest/config';

// Forces the default multi-threaded worker pool down to a single thread.
//
// Verified directly (not a defensive guess): with the default pool, the
// full maple-common suite (119 spec files, 1273 tests as of #1995) is
// genuinely non-deterministic — different, unrelated test files fail at
// random roughly 1 run in 3-4, while `origin/main`'s smaller suite (114
// files) was 100% stable across many repeated runs, and every individual
// suspect file passed 100% of the time in isolation. Forcing
// `singleThread: true` made the full suite pass 100% reproducibly across
// repeated runs — this is a real race in the test-runner's parallel
// worker-thread pool at this file count, not a bug in any one spec or
// service. The cost is wall-clock (single-threaded run time is comparable
// to or only slightly slower than the flaky multi-threaded runs observed
// here, since the failures were sporadic rather than a fixed slowdown) —
// worth it for a deterministic CI gate.
export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
