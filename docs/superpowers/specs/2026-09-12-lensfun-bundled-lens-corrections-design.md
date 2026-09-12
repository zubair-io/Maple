# Bundled Lensfun lens corrections

Automatic distortion, lateral chromatic aberration and vignetting correction for every lens the Lensfun database knows, on every Maple platform, with no import step. The user-owned LCP import (#3395) stays as the override for a profile Lensfun lacks.

Decisions taken on 2026-09-12: a matched calibration is applied automatically, with a dropdown to change the lens and the existing master toggle to turn it off; the database ships inside raw-core; the Apple panel lands first, then Windows and Web.

## Why Lensfun

Adobe's LCP library is only available to people who install Adobe software, and its licence does not allow Maple to redistribute it. A lens-correction feature that depends on that is not a feature. Lensfun's database is open data under CC BY-SA 3.0, covers 1,568 lenses and 1,051 camera bodies as of its 2026-09-11 snapshot, and its models are documented and implemented in `liblensfun`, which Maple uses as the reference for its port.

## Source data

The snapshot is the `data/db/*.xml` directory of `github.com/lensfun/lensfun` at a pinned commit (5.1 MB of XML across 59 files). The schema per lens is `maker`, `model` (with `lang` variants), one or more `mount`, `cropfactor`, `aspect-ratio`, optional `type` (only `rectilinear` is supported; fisheye and other projections are skipped and reported in the coverage document), optional `real-focal` per sample, and a `calibration` block of samples:

- `distortion` — `model="ptlens"` (a, b, c; 5,446 samples), `poly3` (k1; 870) or `poly5` (k1, k2; 5), one per focal length.
- `tca` — `model="poly3"` (vr, vb, cr, cb, br, bb; 3,766) or `linear` (kr, kb; 5), one per focal length.
- `vignetting` — `model="pa"` (k1, k2, k3; 29,505), one per (focal, aperture, distance).

Cameras carry `maker`, `model`, `variant`, `mount` and `cropfactor`; mounts carry `name` and a `compat` list.

## Coordinate system and model conversion

`liblensfun` evaluates every model in a frame where the radius is the physical distance from the optical centre in millimetres divided by the real focal length. Maple's LCP `Frame` normalises the radius by the focal length in pixels, which is the same quantity. So a Lensfun sample converts into raw-core's `Calibration` by rescaling coefficients, exactly as `rescale_polynomial_coefficients` does in `mod-coord.cpp`, `mod-subpix.cpp` and `mod-color.cpp`:

- `s = real_focal / h`, with `h = hypot(36, 24) / crop / hypot(aspect, 1) / 2` for distortion and TCA (the Hugin frame, where r = 1 at half the short side) and `h = hypot(36, 24) / crop / 2` for vignetting (r = 1 at the corner). `crop` and `aspect` are the calibration's own values.
- `poly3`: `Rd = Ru · (1 − k1 + k1·Ru²)`. With `d = 1 − k1`, raw-core stores `k1' = k1 · s² / d³` in the even radial term and `scale = 1`: `liblensfun` folds the `d` factor into its coordinate frame and treats the remaining pure zoom as not part of the correction, and the parity tests confirm the reference output carries no zoom.
- `poly5`: `Rd = Ru · (1 + k1·Ru² + k2·Ru⁴)`; `k1' = k1·s²`, `k2' = k2·s⁴`.
- `ptlens`: `Rd = Ru · (a·Ru³ + b·Ru² + c·Ru + 1 − a − b − c)`. With `d = 1 − a − b − c`, `scale = 1`, `a' = a·s³/d⁴`, `b' = b·s²/d³`, `c' = c·s/d²` (same treatment of `d` as `poly3`). The `c·r` and `a·r³` terms have odd powers, which the current even-only polynomial cannot represent, so `Perspective` gains `radial_odd: [f64; 2]` (coefficients of `r` and `r³`), zero for every Adobe profile. The evaluator takes the square root only when either odd term is non-zero, so the Adobe path is unchanged.
- `tca poly3`: per channel `Rd = Ru · (b·Ru² + c·Ru + v)`; `v` becomes the channel's `scale`, `c·s` its `radial_odd[0]`, `b·s²` its even `radial[0]`. `linear`: `scale = k`.
- `vignetting pa`: `I(r) = 1 + k1·r² + k2·r⁴ + k3·r⁶` is the same illumination polynomial `Vignette` already divides by; `kn' = kn · s^(2n)`.

`liblensfun` measures pixel coordinates at pixel centres: the optical centre of a `w`-wide frame is index `(w − 1) / 2` and the diagonal is `hypot(w, h)` pixels; the runtime frame reproduces both.

Focal length, aperture and distance samples are selected and interpolated by the existing resolver (log focal, reciprocal distance, APEX aperture), not by `liblensfun`'s spline and inverse-distance weighting; Maple keeps one interpolation code path for both profile kinds. The conversion is verified at exact sample points, where no interpolation happens, against numbers produced by `liblensfun` for the same inputs.

A calibration made on a smaller sensor is not used for a larger one: as in `liblensfun`, a lens calibration set is eligible only when `camera_crop / calibration_crop ≥ 0.96`.

## Matching

1. Camera: EXIF make and model, normalised the way the LCP resolver normalises (case and whitespace), against the Lensfun camera list including `variant`. The match yields the mount and the crop factor. Without a camera match there is no automatic correction, and the panel says so.
2. Lens: the EXIF lens name (or its capture-IFD fallback from #3482), normalised, against the `model` of every lens whose mount is the camera's mount or one the camera's mount lists as `compat`. Exact normalised equality only; no fuzzy scoring. `lang` variants and Maple's `AlternateLensNames` normalisation are all accepted spellings.
3. Manual choice: the dropdown lists every lens on a compatible mount, so a user can pick the calibration for a lens the EXIF does not name (adapted glass, manual lenses).

## Precedence and persistence

Embedded DNG `OpcodeList3` corrections still win over everything and are never compounded. An explicit LCP selection (`lcp1:` / `lcp1-ack:`) wins over a Lensfun match. Otherwise a Lensfun match is applied when `crs:LensProfileEnable` is on.

An automatic match writes nothing to the sidecar, the same rule as Auto Profile: the sidecar stays omit-on-default, and reproducibility comes from the database version pinned in the build. A manual pick writes `papp:LensProfile="lensfun1:<slug>"`, where the slug is the normalised `maker/model/mount`, so it survives every host. `lens_profile` stays non-copyable. The render evidence hosts already receive (`lens_profile_json`) gains `source: "lensfun"`, the lens name, the database version, and the per-family coverage, which is what the panel shows.

## Bundle

`src/scripts/convert_lensfun_db.py` reads the pinned snapshot and writes `raw-core/src/lens_profile/lensfun/db.bin`, a compact little-endian table (cameras, mounts with compat lists, lenses with their converted samples as `f32`), plus `ATTRIBUTION.md` (CC BY-SA 3.0 text, the source commit and date, and the conversion rules) and a generated `COVERAGE.md` with counts and the skipped entries. raw-core includes the table with `include_bytes!`, so the xcframework, the Windows DLL, the API dylib and wasm all carry it. The converted table is expected to be about one megabyte, dominated by vignetting samples; if it breaks the Hosted eager-payload ratchet, wasm loads it lazily instead of embedding it, and that is the only platform difference allowed.

## Slices

1. **raw-core**: converter script, bundle, reader, `radial_odd` evaluator, camera/mount/lens index and matcher, `lensfun1:` reference form, tests against `liblensfun` reference values and a round trip of every bundled sample through the evaluator. Closes the first sub-issue.
2. **Develop path**: automatic matching in `apply_for_raw` and the sized path, the evidence fields, `maple-cli render --lens auto|off|<slug>`, and an objective gate: on a fixture where both an Adobe LCP and a Lensfun calibration exist for the same lens, the two corrected renders must agree within a ΔE2000 and geometric budget recorded in `budgets.json`. API, Windows and Web get the correction from this slice with no UI change.
3. **Apple panel**: a profile dropdown in `LensCorrectionsSection` (Automatic with the matched lens, every compatible lens, the imported profile if one is registered) and the source line; the master toggle stays the off switch.
4. **Windows panel**, then **Web panel**: the same dropdown in each host's Lens section.

## Out of scope

Fisheye and other non-rectilinear projections, Lensfun's perspective-correction module, fetching database updates at runtime, and any use of Adobe's profile library.
