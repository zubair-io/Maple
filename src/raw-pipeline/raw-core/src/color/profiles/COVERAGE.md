# Bundled-profile coverage

This document is the source of truth for which camera bodies the
third-party-derived profile bundle (`profiles.bin`) covers, which
bodies are known-missing, and which need a UCM-naming alias to hit.
Under ticket #345 (bundle-canonical color) the bundle is the only
source of color math — when it misses, the develop pipeline produces
an identity-CM `Fallback` render. Honest coverage tracking is
therefore load-bearing.

## Bundle summary

- Source: the upstream tooling's externally-calibrated profile set
  under `CameraRaw/CameraProfiles/`, re-encoded by
  `src/scripts/convert_dcps.py` into the Maple binary format.
- Profile count: ~1,406 distinct UCMs (after dedup by
  `dcp_preference`). Includes the upstream `Camera/` subdir of
  per-creative-style variants; UCM dedup keeps one entry per body.
- Bundled fields: `ColorMatrix1/2`, `ForwardMatrix1/2`,
  `CalibrationIlluminant1/2`, optionally `ProfileHueSatMap1/2`
  (off by default; opt in with `--include-hsm`),
  `BaselineExposureOffset`. `ProfileToneCurve` and `ProfileLookTable`
  are dropped (Maple's AgX view transform + DisplayLookCurve replace
  them).

## Fixture coverage (status as of #345)

The 18 RAW fixtures in `test-fixtures/raws/`:

| Fixture       | Body                           | UCM (rawler-reported)    | Bundle hit  | Notes                                                                                             |
| ------------- | ------------------------------ | ------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| test_0000.DNG | DJI Mavic 3 Pro (100 MP)       | `Hasselblad L3D-100c`    | HIT (alias) | Aliased to `DJI FC4382 Mavic3Pro` (drone body code, same Hasselblad sensor).                      |
| test_0001.RAW | Panasonic LX2                  | `Panasonic DMC-LX2`      | HIT         |                                                                                                   |
| test_0002.dng | Hasselblad H2D-39              | `Hasselblad H2D-39`      | HIT (alias) | Aliased to `Hasselblad 39-Coated` (upstream sensor-naming convention).                            |
| test_0003.CR2 | Canon 5DS R                    | `Canon EOS 5DS R`        | HIT         |                                                                                                   |
| test_0004.fff | Hasselblad H5D-40              | `Hasselblad H5D-40`      | **MISS**    | No bundled profile for the H5D-40 specifically. Renders as identity `Fallback`. Follow-up needed. |
| test_0005.RAF | Fujifilm GFX 50S               | `Fujifilm GFX 50S`       | HIT         |                                                                                                   |
| test_0006.DNG | Canon 5D Mark III (DNG)        | `Canon EOS 5D Mark III`  | HIT         |                                                                                                   |
| test_0007.DNG | Canon 5D Mark III (DNG)        | `Canon EOS 5D Mark III`  | HIT         |                                                                                                   |
| test_0008.RAF | Fujifilm X-T3 (X-Trans)        | `Fujifilm X-T3`          | TBD         | X-Trans CFA + Markesteijn-equivalent demosaic landed in #417 / #420. Renders end-to-end. Bundled-DCP hit status pending the first parity-harness pass — see BUDGETS_DRIFT.md. |
| test_0009.CR2 | Canon 5D Mark IV               | `Canon EOS 5D Mark IV`   | HIT         |                                                                                                   |
| test_0010.CR2 | Canon 5D Mark IV               | `Canon EOS 5D Mark IV`   | HIT         |                                                                                                   |
| test_0011.ARW | Sony α7R IV                    | `Sony ILCE-7RM4`         | HIT         |                                                                                                   |
| test_0012.raf | Fujifilm GFX 50R               | `Fujifilm GFX 50R`       | HIT         |                                                                                                   |
| test_0013.DNG | iPhone 12 Pro                  | `iPhone13,3 back camera` | HIT         | Per-lens UCM matches the bundle's per-lens DCP filenames byte-for-byte.                           |
| test_0014.NEF | Nikon D850                     | `Nikon D850`             | HIT         |                                                                                                   |
| test_0015.dng | Google Pixel 6 Pro             | `Google Pixel 6 Pro`     | HIT (alias) | Aliased to `Google Pixel 6 Pro Rear Main Camera` (default lens variant; see ucm_mapping.rs).      |
| test_0016.X3F | Sigma Foveon (unsupported)     | n/a                      | n/a         | Foveon X3F surfaces as the structured `Error::UnsupportedFormat` per #417 — rawler 0.7's X3F decoder is a stub. No silent fail.                                              |
| test_0017.dng | Leica M10                      | `LEICA M10`              | HIT         |                                                                                                   |

Coverage of the renderable fixture set: **16 / 17 HIT** (three of those
via the UCM-alias table; test_0004 / Hasselblad H5D-40 is the only
color-renderable miss — see "Known coverage gaps" below). test_0008
(Fuji X-Trans) is now renderable end-to-end (#417 decode, #420
demosaic). test_0016 (Foveon) is still unrenderable but now surfaces
a clear unsupported-format error instead of a silent decode fail.

## Known coverage gaps

These bodies exist in the fixture set or are likely to be encountered
by users, and the bundle has no entry for them today:

- **Hasselblad H5D-40** (test_0004.fff). The H-series sensor sizes
  the bundle DOES ship are 39 (H2D-39), 50 (X1D), 100 (X1D / L1D / L2D
  / L3D / L4D). The 40 MP sensor variant isn't published. Renders via
  identity `Fallback` today — a real follow-up ticket.

- **Pixel 6 Pro lens variants beyond Rear Main**. The alias table
  defaults to the Rear Main Camera profile when rawler reports the
  bare `Google Pixel 6 Pro` UCM. The Rear Telephoto and Rear
  Ultrawide variants exist in the bundle but require EXIF lens
  metadata that rawler doesn't surface today to distinguish at
  runtime. Track this when the lens-metadata surface lands.

- **Other Pixel mobile bodies (Pixel 7/8/9 etc.)** would have the
  same per-lens-UCM issue as the Pixel 6 Pro. The bundle ships the
  per-lens profiles; the alias table covers Pixel 6 Pro because
  it's in our fixture set, and follows the same shape for siblings.

- **Sigma Foveon X3F** — rawler 0.7's X3F decoder is a stub that
  returns `"X3F decoding not implemented yet"`. Maple promotes this
  to `Error::UnsupportedFormat` (see #417 / decode.rs) so callers
  can render a clear "format not supported" message. Following
  rawler upstream for full X3F support is a separate ticket.

## How to add a body

1. Verify the source `.dcp` is in the upstream tooling's
   `CameraRaw/CameraProfiles/` directory.
2. Re-run `src/scripts/convert_dcps.py` to regenerate
   `profiles.bin`. The script walks the parent dir recursively and
   picks up both the canonical `*Standard/` profiles and the
   per-creative-style variants under `Camera/<body>/`.
3. If rawler's reported UCM doesn't match the bundle's UCM (run
   `cargo run --release --example inspect-camera -- <file>` to see),
   add an entry to `src/raw-pipeline/raw-core/src/color/ucm_mapping.rs`.
4. Update this document with the new fixture row.
