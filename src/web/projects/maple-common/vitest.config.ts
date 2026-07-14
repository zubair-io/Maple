import { defineConfig } from 'vitest/config';

// Forces the default multi-threaded worker pool down to a single thread.
//
// The full maple-common suite (119 spec files, 1273 tests as of #1995) was
// measurably less stable under the default multi-threaded pool than
// single-threaded (roughly 1-in-3-4 runs saw an unrelated random test fail
// vs. cleaner runs single-threaded). This is a real, if partial, stability
// improvement — it did NOT turn out to be the full story behind the
// specific flake that motivated this investigation (a `vi.mock('exifr',
// ...)`-interception race, ultimately fixed properly by routing that
// dependency through Angular DI instead — see `exif-reader.service.ts`'s
// module doc), but the multi-vs-single-thread stability delta was real and
// independently confirmed, so it stays.
export default defineConfig({
  test: {
    // `poolOptions.threads.singleThread` was removed in Vitest 4 ("all
    // previous poolOptions are now top-level options" per its own
    // deprecation warning); `fileParallelism: false` is the current
    // equivalent — run test files sequentially instead of across a
    // multi-threaded pool.
    fileParallelism: false,
  },
});
