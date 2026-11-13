# Saved-removal 100MP editor measurement — #1472

The release Swift package benchmark opens the canonical 12288 × 8192 RAW
through the production `EditSession` → `RenderActor` → `GpuLiveDriver` path.
Each 0/1/10-removal case has a fresh copied RAW, real XMP, and content-addressed
companions in its own disposable library. Auto remains the profile. The original
digest is unchanged; the three GPU frame digests differ and repeat across runs.
Slider inputs reuse the decoded RAW and preserve the exact accepted-record JSON.

The companions contain controlled, constant scene-linear 512 × 512 patches with
full coverage. They measure saved-stack render cost, not AI reconstruction quality.
The final harness also checks the canonical byte count and SHA-256 against the
existing `browser-100mp-3669.json` authority before opening the editor.

[Machine-readable measurements](removal-100mp-editor-1472.json) preserve both
consecutive runs, including delivered input rate and missed/coalesced publications.
Both passed with zero test failures or skips on an Apple M5 Max, macOS 27.0
(26A428), 60Hz display, nominal thermal state, at a 1920 × 1280 viewport.
The final guarded-source verification also passed with zero failures/skips:
worst publication 11.41ms, 359 of 360 published inputs, and cold opens
997/1147/1347ms for 0/1/10 patches. Its complete rows are retained separately
in the JSON; it was run to verify the identity guard, not to replace either
consecutive measurement.

| Accepted patches | Exposure p95, runs 1 / 2 | Contrast p95, runs 1 / 2 | Cold open, runs 1 / 2 |
| ---------------- | -----------------------: | -----------------------: | --------------------: |
| 0                |           3.19 / 4.19 ms |           3.37 / 4.30 ms |         1048 / 947 ms |
| 1                |           2.10 / 4.14 ms |           2.09 / 7.28 ms |        1291 / 1101 ms |
| 10               |           2.09 / 2.48 ms |           4.17 / 2.12 ms |        1597 / 1430 ms |

All observed publications were below the 16ms target and 50ms asserted hard
limit. Run 1 published 359 of 360 inputs, and run 2 published 356 of 360; this
does not establish one displayed frame per input. The worst observed publication
was 15.99ms. Several cold opens exceed the 1000ms uncached-open target.

No compiler from this task was active during measurement. An unrelated Just
Maple app was sampled near one CPU core between runs, so these are descriptive
measurements rather than a quiet-machine performance ratchet. Both runs are
retained without selecting a favorable row or changing an existing perf budget.

Timing ends at observed GPU submission acknowledgement. The 1ms publication
poller adds observation latency and can miss frames. Gesture dispatch, scanout,
allocation/peak-memory traces, model inference, photographic quality, full-native
generation/export, Web, and other devices remain outside this measurement.

Reproduce from the repository root with the canonical RAW installed and release
Rust xcframework available:

```sh
cargo run --release --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --example removal-perf-fixture -- test-fixtures/raws/dji-mavic3pro-100mp.dng test-fixtures/raws/removal-perf
swift build -c release --build-tests -Xswiftc -enable-testing --package-path src/apple/Packages/MapleCore
MAPLE_PERF=1 swift test -c release --skip-build -Xswiftc -enable-testing --package-path src/apple/Packages/MapleCore --filter EditorWorkflowPerfTests.test100MPAcceptedRemovalStacksAt60Hz
```

The fixture generator requires a new output directory, refuses a smaller source,
and checks the XMP accepted-record round trip. Missing fixtures explicitly skip
the benchmark and provide no qualification evidence. Initial invalid fragment
sidecars failed setup before any timing; the corrected generator produced the
complete documents used in the recorded successful runs. No shipping pipeline
math, original file, color reference, or acceptance budget was changed.
