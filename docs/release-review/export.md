# Export release review (v0.1.6)

Static code review of X1-X4 against `origin/main`. No test suites were executed for this review.

| ID  | Feature                                                   | Verdict       | Findings       |
| --- | --------------------------------------------------------- | ------------- | -------------- |
| X1  | JPEG/TIFF/PNG/AVIF/WebP/HEIC with correct ICC and P3/sRGB | works with P2 | X-P2-1         |
| X2  | Resize caps, never upscale, quality                       | works with P2 | X-P2-2, X-P2-3 |
| X3  | Saved recipes and durable batch queue                     | works         | none found     |
| X4  | AI-agent MCP export (macOS)                               | works         | none found     |

No P0 and no P1 findings. No fix PRs were opened.

## What was checked

- **X1.** `raw-core/src/export.rs` selects the buffer depth from the format, tags JPEG, PNG, TIFF and P3 WebP with `icc::profile_for(target)`, and routes AVIF through `encode_avif_tagged` with the same primaries. Export shares `render_display_scene` with the canvas, so colour is the canvas pipeline. The web (`raw-wasm/src/export.rs`), FFI (`raw-ffi/src/export_file.rs`) and recipe paths all build `ExportOptions` with the same primaries mapping. Apple single-photo export (`MapleExporter.swift`) encodes through Core Image into sRGB, Display P3 (JPEG and HEIC), gamma sRGB (PNG) and linear sRGB (16-bit TIFF).
- **X2.** `downsample_image_area` never upscales. Web, FFI and recipe callers pass `0`/`None` for native resolution. JPEG quality is clamped to 1-100. Recipe validation requires lossless formats to carry `null` quality.
- **X3.** `api/src/export/export-files.ts` stages with an exclusive hard link (error/skip) or atomic rename (replace), refuses destinations that equal a selected or catalogued original, and records the staging path and prepared SHA-256 before publication. `export-payload.ts` bounds targets (2,000) and payload size (12 MB) and rejects non-absolute paths. Recovery compares the recorded before/after hashes.
- **X4.** `AgentPhotoExporter.swift` takes only `expected_revision`, renders with the Export panel defaults, writes `Documents/Exports/<stem>-<UUID>.jpg` via a staged file and `moveItem` (which refuses an existing destination), checks the revision and cancellation immediately before publication, and validates the destination against the original.

## Findings

### X-P2-1: Apple 16-bit TIFF is linear sRGB; Rust TIFF is gamma-encoded

- Where: `src/apple/Packages/MapleCore/Sources/MapleCore/MapleExporter.swift` (`targetColorSpace`, `.tiff16`) vs `raw-core/src/export.rs` (`encode_tiff16`, gamma-encoded with an sRGB or P3 ICC).
- Scenario: export the same edit as TIFF from Apple and from web. Both carry an ICC profile, so ICC-aware viewers agree, but a tool that ignores the profile reads the Apple file as far too dark. Apple TIFF also cannot be Display P3.
- Severity: P2. The behaviour is documented in code (#1511).

### X-P2-2: The long-edge cap is applied to the uncropped frame

- Where: `raw-core/src/pipeline/render/export.rs` (`render_display_scene` receives `max_long_edge`, crop runs afterwards in `finish::apply_geometry`); `export-dialog.vm.ts` `croppedOutputDimensions` mirrors it.
- Scenario: 6000x4000 source, 50% crop, cap 2048. The output is about 1024 px on the long edge, not 2048. The export dialog shows the cropped size (#5319), so the result is predictable, but "max long edge" is not the delivered long edge.
- Severity: P2, needs a product decision before changing; web, Rust and the dialog agree today.

### X-P2-3: Apple single-photo export has no custom size cap

- Where: `ExportPanel+VM.swift` builds `ExportOptions(format:quality:sizeOption:)`; `maxSidePixels` is never set by the app. Choices are Fast (a viewport-derived edge, labelled with its pixel value) or Full.
- Scenario: a user wanting a 1600 px deliverable on Mac or iPad has no way to ask for it, while web offers 4096/2560/2048/1024. Fast renders at preview demosaic quality.
- Severity: P2 (parity gap, not a defect in what is offered).

## Not verified

- No Rust, Swift, Bun or Angular tests were run, and no export was produced and inspected; verdicts rest on code reading and the existing test inventory described in `docs/export-recipes.md`.
- The Windows queue (`src/windows`) and the Apple recipe queue (`MapleCore/ExportRecipes`) were not read line by line.
- HEIC output on a physical device and ICC rendering in third-party viewers were not exercised.
