# 10 — CLI Test Harness

The Rust core ships with a CLI binary that is the primary interface for
iterating on the pipeline. It exists before any UI layer does. If a
rendering behaviour can't be exercised from the CLI, it can't be tested,
and it doesn't belong in the core yet.

## Purpose

- **Deterministic** — same RAW + same params → byte-identical PNG, across
  machines and across the WASM / Swift FFI / native builds. No GPU
  nondeterminism, no thread-order drift in the output.
- **Headless** — no window, no GL/Metal context owned by a UI framework.
  The core opens its own compute device (Metal / WebGPU / CPU fallback)
  or runs fully on CPU for regression gates.
- **Fast feedback** — render one case in seconds, the full 176-case ACR
  matrix in minutes. The CLI is the inner loop for every algorithm
  change.
- **Single source of truth** — the CLI is the reference renderer. Web
  (WASM) and iOS (Swift) are thin shells around the same core. If the
  CLI render and a UI render of the same params differ, the UI is
  wrong.

## Non-goals

- The CLI is **not** an end-user tool. No catalog, no library, no batch
  export UX. It's a test harness.
- No preview-only shortcuts. The CLI always runs the exact pipeline the
  spec describes — preview vs. export is controlled by explicit flags,
  not by "is this interactive".

## Input contract

A CLI invocation needs three things:

1. **A RAW file** — one of the fixtures under `test-fixtures/raws/` or
   any supported format from `08-io.md`.
2. **A parameter set** — in exactly one of these forms:
   - An ACR XMP sidecar (`crs:` namespace, PV2012). This is the same
     format the ACR reference matrix uses. The core parses it and maps
     the `crs:` fields onto its own edit-stack types. Unmapped fields
     log a warning and are ignored.
   - A native Maple edit-stack document (JSON, schema defined in
     `01-data-model.md`). Canonical format once the pipeline outgrows
     the ACR slider set.
   - CLI flags for single-parameter overrides (`--exposure -1.5
     --contrast 40`) layered on top of a loaded sidecar. Used mostly
     for ad-hoc bisection.
3. **A render descriptor** — tier, zoom level, crop region, and output
   colour space. Defaults match ACR: sRGB 8-bit PNG at native or 4000 px
   long-edge.

## Output contract

- PNG, sRGB IEC61966-2.1, 8-bit, non-interlaced, compression 6. Matches
  the ACR reference output exactly so `compare_images.py` can diff them
  without profile conversion.
- Alongside the PNG, a sidecar `<output>.render.json` records: input
  RAW path + checksum, resolved parameter set (post-XMP parsing), tier,
  zoom level, pipeline version, core git SHA, render duration per
  stage, and any warnings. This file is the audit trail for a render.

Optional outputs behind flags:

- **Per-stage dumps** (`--dump-stages`) — one PNG per pipeline stage
  (demosaiced, WB-applied, tone-mapped, sharpened, …). Critical for
  debugging which stage introduced a regression.
- **16-bit linear EXR** (`--format exr`) — for diffing intermediate
  colour without sRGB crush.
- **Stats JSON** (`--stats`) — histogram, min/max per channel, clipped
  pixel count. Cheap regression signal that doesn't need a reference
  image.

## Command surface

```
maple-cli render <raw> --params <xmp|json> --tier <down|full> \
                       --zoom <25|50|100|fit> --out <path.png>

maple-cli batch  <manifest.json> --out-dir <dir>
                 [--cases-filter <name>...] [--parallel <n>]

maple-cli diff   <rendered.png> <reference.png>
                 [--budget <deltaE>] [--metric ciede2000|rmse|both]

maple-cli inspect <raw>                  # decode header, print metadata
maple-cli inspect <xmp>                  # parse, print resolved params
maple-cli inspect <stack.json>           # validate, print resolved params
```

`batch` consumes a manifest identical in shape to the one
`src/scripts/acr-reference/run.py` writes for Photoshop, so the same
manifest drives both the ACR reference generation and the Maple
validation render. One input, two renderers, directly comparable.

## Tier and zoom semantics

The CLI exposes both axes independently so tests can pin them:

- **Tier** — `down` (4000 px long-edge bicubic-sharper, matches ACR
  `down/`) or `full` (native resolution, matches ACR `full/`). Tier
  affects the output image size only; it does not change pipeline
  behaviour.
- **Zoom** — simulates the UI's view-dependent preview path. `25` and
  `50` route through the downsampled-image preview; `100` routes
  through tiled full-resolution processing; `fit` picks based on output
  dimensions. Zoom affects **how** the pipeline runs, not what it
  produces at max quality.

A render at `--tier full --zoom 100` is the export path and must match
the ACR `full/` reference. A render at `--tier down --zoom 25` is the
interactive-zoomed-out preview and must match the ACR `down/`
reference. Divergence between those two paths on the same params is a
bug in the preview strategy, not in the pipeline — see `11-testing.md`
for how the dual-path validation is gated.

## Determinism requirements

Every build of the core must produce the same PNG for a given (RAW,
params, tier, zoom) tuple. Concretely:

- No timestamps, no random seeds without a fixed seed in the render
  descriptor.
- Reductions (histogram, colour stats) use deterministic order even when
  parallelised.
- GPU kernels use fixed workgroup sizes; any op whose GPU result can
  drift from its CPU result is flagged in `05-performance.md` and
  validated against the CPU path in CI.

CI gates a `maple-cli render` of the baseline against a
byte-for-byte-expected PNG checked into the repo (one per RAW, CPU
backend). GPU backends gate against the same PNG with a tiny ΔE
tolerance documented per platform.

## Integration with existing scripts

The CLI slots into the workflow already established in
`test-fixtures/references/REFERENCES.md`:

```
src/scripts/acr-reference/run.py         # writes XMPs + manifest.json
src/scripts/acr-reference/acr_batch.jsx  # ACR renders references
maple-cli batch <manifest.json>          # Maple renders candidates
src/scripts/compare_images.py            # CIEDE2000 diff, both sides
```

`compare_images.py` stays authoritative for the perceptual metric. The
CLI's `diff` subcommand is a convenience wrapper around it so ad-hoc
comparisons from a dev machine don't need the Python env set up.

## Open questions

- Should the native edit-stack JSON be a superset of ACR XMP (same
  field names under a different namespace) or a clean break? Affects
  how long the XMP translation layer lives.
- Per-stage dump format for GPU intermediates — round-trip through
  readback is expensive, acceptable for debug runs only.
- Multi-RAW batch parallelism: per-case or per-RAW? Per-RAW is simpler
  but leaves GPU underused on small cases; per-case risks contention
  on the GPU device.
