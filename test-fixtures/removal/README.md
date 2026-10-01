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
