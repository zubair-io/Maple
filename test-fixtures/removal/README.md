# Removal persistence interoperability

`basic/` is a tiny synthetic DNG plus lossless mask, HDR patch, preparation request,
accepted records, and a foreign XMP envelope. It contains no personal photographs.
Rust, Swift, and browser WASM tests use the same bytes to exercise real companion
publication and sidecar saves. Patch values include negative scene values and an
HDR channel above one; preserving these values is part of the contract.
`request.txt` and `records.txt` store the exact compact JSON wire text produced
by Rust, including its canonical attribute ordering, rather than a reformatted
presentation.

Regenerate from the repository root:

```sh
cargo run --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --features test-support --example removal-fixture -- test-fixtures/removal/basic
cp test-fixtures/removal/basic/* src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/removal/
```

The Apple copy is required by Swift Package Manager's resource boundary. Commit
both copies together and verify that they remain byte-identical.

`calibration/` binds the same RAW and signed HDR patch to the real decoder's
fixed linear-calibration source anchor (schema 4). `saved.xmp` references both
companions. The RGB8 previews at 4px and 64px long-edge requests come from the
shared Auto-quality display chain, before any host image conversion. C and Swift
saved-session tests compare those bytes and decode lossless exports. This is a
synthetic interoperability fixture, not photographic or device qualification.

The calibration generator also emits quality-90 JPEG references directly from
those committed RGB pixels. API tests use them as independent lossy-derivative
oracles, rather than comparing two RAW renders that could both omit a patch.
The real child worker tests cover lossless recipe exports, developed JPEG,
histograms, schema-5 disable/re-enable, cold/warm/regenerated AVIF caches and
fail-closed handling of missing/corrupt assets, changed originals and future
schemas. Real SQLite export jobs additionally verify queued edit snapshots,
per-photo companion failures and recovery after lost publication acknowledgement.
The API library is built without authoring inference; accepted edits need no
installed model. A missing native build visibly skips and proves no qualification.
The first local run passes all 14 new tests without skips; measured results and
the remaining scope limits are recorded in
[`removal-api-saved-consumers-1472.json`](../qualification/removal-api-saved-consumers-1472.json).

```sh
./src/api/scripts/build-raw-ffi.sh
cd src/api
bun install --frozen-lockfile
bun test src/indexer/removal-sidecar-derivatives.test.ts src/export/removal-export.integration.test.ts
```

```sh
cargo run --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --features test-support --example removal-fixture -- test-fixtures/removal/calibration --calibration
cp test-fixtures/removal/calibration/* src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/removal/calibration/
```

Native inference diagnostics use optional files under the gitignored
`test-fixtures/raws/removal-inference/` directory. No test downloads models or
uploads photos. In addition to the reconstruction corpus, selection tests need
the pinned `mobile-sam-encoder.onnx`, `mobile-sam-decoder.onnx`, and
`rtdetrv2-r18.onnx`, plus the explicitly provisioned `runtime.dylib`.
`selection-context.json` is the RAW-context probe output containing
`source_anchor`; `selection-request.json`, `selection-input.png` (RGB8 1024²),
and `selection-reference.mimf` describe its refinement. Detection uses
`detection-input.f32` (CHW 640²), `detection-input.json` with `size: [width,height]`,
and `detection-reference.json` containing the pinned native proposals.

```sh
cargo test --manifest-path src/raw-pipeline/Cargo.toml -p raw-ffi --features removal --lib real_native_selection_and_detection -- --ignored
cd src/apple/Packages/MapleCore
swift test --filter NativeRemovalSelectorTests
```

The Rust test is ignored unless explicitly invoked with that corpus; the Swift
test visibly skips when it is absent. Neither an ignore nor a skip constitutes
model, photographic, or physical-device qualification. Committed model pins are
the authority for accepted artifact checksums.

The 100MP editor benchmark uses the exact `dji-mavic3pro-100mp.dng`, with
controlled 0/1/10 accepted stacks. Each patch is a 512-square, constant
scene-linear replacement with full coverage. This measures saved-edit render
cost and decode reuse; it does not qualify inference or photographic quality.
The fixture generator reads the original, refuses a smaller image, and requires
a new output directory. Generated companions remain gitignored.

```sh
cargo run --release --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --example removal-perf-fixture -- test-fixtures/raws/dji-mavic3pro-100mp.dng test-fixtures/raws/removal-perf
swift build -c release --build-tests -Xswiftc -enable-testing --package-path src/apple/Packages/MapleCore
MAPLE_PERF=1 swift test -c release --skip-build -Xswiftc -enable-testing --package-path src/apple/Packages/MapleCore --filter EditorWorkflowPerfTests.test100MPAcceptedRemovalStacksAt60Hz
```

The benchmark clones each library, loads its real XMP/companions through the
normal editor, checks changed GPU pixels, and measures Exposure/Contrast at
60Hz using the existing workflow harness. It reports hardware, thermal state,
source/frame digests, coalesced publications, the 16ms target and 50ms hard limit.
The hard limit is asserted. Timing ends at observed GPU submission; it excludes
gesture dispatch, scanout and allocation tracing. Missing fixtures visibly skip
and provide no qualification evidence. Record on a quiet reference device;
concurrent build activity makes a run diagnostic, not release qualification.
The canonical byte count and SHA-256 are checked against the committed browser
fixture identity before measurement. The first macOS 0/1/10 measurements and
their limitations are recorded in
[`removal-100mp-editor-1472.md`](../qualification/removal-100mp-editor-1472.md).
