# Raster noise metadata parity — #4653

Developed JPEG/PNG/TIFF pixels have no scene-linear sensor noise calibration.
The CPU raster exporter, detail path and browser `develop_non_raw` inherited
ISO 100 from the generic chain default; native Android GPU and Apple paths
use unknown ISO 0. Windows also supplied the invented 100. Restoring the
existing noise fallback in #4638 exposed this inconsistent input metadata.

`ChainOptions::uncalibrated_raster()` now sets `skip_agx` and unknown ISO 0
for those three CPU entries. Windows uses 0 when creating its decoded raster.
Actual RAW ISO values and the generic chain default are unchanged. Output
version 42 invalidates derived renders; Auto-fit version 12 is unchanged.

## Attribution and regression

The unmodified main `3613a6b9cf5e95a9bd1b41103752439088387d3f` passes all three
original Android raster parity tests. Integrated repair commit
`e78c9ff079fec1debe5a29a015c29b4dc88d894d` fails the sRGB and Display-P3
controls at three bytes against their unchanged two-byte ceiling; the float
control passes. An isolated source snapshot with only CPU raster-export ISO
changed to 0 passes all three at exposures 0, +1.25 and -1.5.

A new independent core regression constructs a color gradient and compares
export with explicit ISO 0 and ISO 100 chain predictions. The controls must
differ by more than one byte. Before the correction it fails at three bytes;
afterward it agrees with ISO 0 within the existing terminal-dither allowance
of one byte. The input bytes remain unchanged. No assertion ceiling was raised.

Apple's FFI CPU helpers and GPU live inputs already default to 0, so no Apple
source change is needed. The Windows scalar correction is inspected here;
a native WinUI build remains a CI requirement.

## Qualification

All five integrated gates pass: core with GPU (2,854 passed; 104 ignored),
WASM host with GPU (74 passed; 8 ignored), FFI with GPU (301 passed; 6 ignored),
the actual `wasm32` browser target with `gpu,parallel,avif`, and file headroom.
All 19 Android native tests pass, including the original two-byte raster
parity assertions. All 17 core raster-export tests pass. Fixture-gated ignored
tests are not counted as physical qualification. The five-gate source audit
finds no changed files. Code generation completed successfully.

Evidence is preserved under
`/Volumes/Projects/maple-color-gate-20261015/raster-noise-4653/`, including
unmodified-main and isolated one-field source identities, frozen executables,
the original failures, the new red/green regression and binding logs.

This report does not establish a passing physical RAW corpus or authorize a
merge. Original assets, authored XMP, reference pixels and numerical budgets
are unchanged.
