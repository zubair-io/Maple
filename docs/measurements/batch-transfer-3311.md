# Batch settings transfer measurement (#3311)

Measured on 2026-09-06 with 2,000 distinct photographs from an existing library: JPG, CR2, HEIC and JPEG files totaling 3,034,079,453 bytes. The files were copied into an isolated temporary directory, anonymized, then streamed into Chromium's disk-backed OPFS using an owned temporary persistent browser profile. No original library files or sidecars were written. This measures Chromium OPFS storage; it does not characterize an external-disk folder picker or a network share.

The declared budget remains **120 seconds and at most 512 MiB of additional resident memory** for 2,000 committed sidecars. The test seeds every staged sidecar with exposure -0.5 before timing, then applies exposure 1.25 and the other tone-group values, so every target receives a changed value on every run.

The measured path is the production Web Worker, per-asset IndexedDB ledger, `BatchSyncAssetIO`, real `LibraryStateService.updateAdjustment`, strict canonical XMP reads, debounced writes flushed through actual `FileSystemWritableFileStream.close`, and Web Locks. The preview scheduler remains active and bounds original fetch/decode work to one asset at a time. Completion means authoritative sidecar commits; derived preview completion is outside this budget.

| Result                          | Measurement                                       |
| ------------------------------- | ------------------------------------------------- |
| Applied / failed                | 2,000 / 0                                         |
| Processing time                 | 12.571 seconds                                    |
| Throughput                      | 159.10 photos/second                              |
| Additional resident memory      | 94.73 MiB                                         |
| Baseline / peak resident memory | 772.22 / 866.95 MiB                               |
| Runtime / machine               | Chromium 147.0.7727.15, Apple M5 Max, macOS arm64 |

All 2,000 resulting XMP files were reread after timing, and every staged original's size and modification time matched its pre-run value. The [JSON report](batch-transfer-3311.json) records phase timings and 79 process-memory samples. RSS sums this Chromium instance's browser, GPU, network and renderer processes; shared pages may be counted more than once. Node and Vite are excluded. Staging and verification are outside both processing time and memory sampling. The persistent profile was closed and removed after the run.

Reproduce from `src/web`, after building/syncing WASM, with 2,000 disposable photo copies named `asset-0000.ext` through `asset-1999.ext` under a temporary directory:

```sh
MAPLE_BATCH_CORPUS=/tmp/maple-batch-photo-copies bun run e2e:batch-library
```

The localhost server accepts only the anonymized files in that temporary corpus and serves them read-only. The browser writes copies and XMP to its own temporary profile. The test writes its report to `/tmp/maple-3311-browser-measurement.json`, and both performance ceilings are hard assertions. The committed tiny DNG pair under `test-fixtures/batch-transfer` is a separate controlled fixture set for rendered white-balance/crop correctness.

The superseded Node/jsdom timing harness failed at 419.572 seconds and, with phase profiling, 287.442 seconds. Those failures are preserved in the [diagnostic report](batch-transfer-3311-jsdom.json). A 20.17-second CPU profile attributed 87.17% of samples to jsdom event-listener registration: each XML parse creates a selector helper that installs additional global-window listeners, whose duplicate checks scan a growing list. The authoritative performance gate therefore runs the native browser DOM parser with the same real state/write path and unchanged budgets. No production behavior was changed to bypass that emulator cost.

Supporting platform checks also passed. Apple completed 2,000 confirmed temporary sidecar writes in 3.762 seconds, with 10.625 MiB of additional process high-water RSS; this was a synthetic sidecar/store exercise, separate from the real-photo browser corpus. Self Hosted completed a separate 2,000-target exercise against real MongoDB and real sidecars in 443.101 seconds, with RSS rising from 122 MiB to 233 MiB under severe concurrent build load. Its originals were synthetic JPEG sentinels. These support platform correctness and do not replace the real-library measurement or establish steady-state network/server performance.
