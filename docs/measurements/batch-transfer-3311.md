# Batch settings transfer measurement (#3311)

Measured on 2026-09-06 with 2,000 distinct photographs from an existing library, copied into an isolated temporary directory. The corpus contains JPG, CR2, HEIC and JPEG files totaling 3,034,079,453 bytes. No original library files or sidecars were written. Filenames are anonymized in the staged copies.

The declared budget is **120 seconds and at most 512 MiB of additional resident memory** for 2,000 committed sidecars. This measures completion of authoritative XMP writes, not completion of derived preview rendering.

The measured run applied all tone-group values through the real `LibraryStateService.updateAdjustment`, strict canonical XMP reads, debounced writes, atomic filesystem close, and one durable per-asset ledger entry per target. The preview persistence scheduler was active and bounded to one original fetch/decode at a time. The test reread all 2,000 resulting sidecars and verified every original's size and modification time remained unchanged. The Node filesystem adapter uses real files; the separate browser tests exercise actual Worker, IndexedDB, Web Locks and OPFS behavior.

| Result                     | Measurement                             |
| -------------------------- | --------------------------------------- |
| Applied / failed           | 2,000 / 0                               |
| Elapsed                    | 97.780 seconds                          |
| Throughput                 | 20.45 photos/second                     |
| Additional resident memory | 94.23 MiB                               |
| Peak resident memory       | 324.84 MiB                              |
| Runtime / machine          | Node 24.14.0, Apple M5 Max, macOS arm64 |

This final run includes the persisted before/after conflict guards and ran under substantial concurrent build load. The full [JSON report](batch-transfer-3311.json) also records heap usage and event-loop delay. This is an end-to-end sidecar measurement on one local machine, not a promise for network shares, remote APIs or every camera decode.

Reproduce from `src/web` with an isolated copied photo corpus:

```sh
MAPLE_BATCH_CORPUS=/path/to/isolated-photo-copies bun x ng test Maple-common --watch=false --include='**/editor/copy-paste/batch-library-benchmark.spec.ts'
```

The test writes XMP files beside the staged photos; use disposable copies. It writes the machine-readable result to `/tmp/maple-3311-library-measurement.json`. The ordinary unit suite skips this one benchmark unless that explicit corpus is supplied. The committed tiny DNG pair under `test-fixtures/batch-transfer` is a different controlled fixture set used for rendered white-balance/crop correctness, not this throughput corpus.

The Self Hosted job runner also completed a separate 2,000-target recovery/throughput exercise against real MongoDB and real sidecars: 2,000 applied, zero failed, 443.101 seconds of processing, with resident memory rising from 122 MiB to a 233 MiB peak. Those targets used synthetic local JPEG sentinel originals rather than the real-photo corpus, and the machine was under severe concurrent build load. This is supporting correctness evidence for the server path, not a replacement for the real-library measurement or a steady-state server performance claim.
