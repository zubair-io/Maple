# Testing

Maple's color correctness is verified objectively against ACR-rendered
references — never by eyeballing screenshots. The gates below run in CI; the
diagnostic tools further down help attribute a residual once a gate moves.

## Parity gates

These are the merge gates. Pixel parity between the Apple, Web, and CLI
pipelines — and color parity against the ACR references — blocks merge.

### Color-pipeline harness (end-to-end)

The canonical color-correctness signal. `src/scripts/test_color_pipeline.sh`
runs `maple-cli batch` against every case in
`test-fixtures/references/manifest.json`, diffs each candidate against its
ACR-rendered reference with `compare_images.py` (CIEDE2000 + per-channel
bias), and gates per-fixture × per-case `mean / p95 / max / bias` against
`test-fixtures/budgets.json`. **Budgets are a one-way ratchet — they only go
down**, in the same commit that delivers the improvement.

```bash
src/scripts/test_color_pipeline.sh
FILTER=test_0000 src/scripts/test_color_pipeline.sh   # spot-check one fixture
FILTER=baseline  src/scripts/test_color_pipeline.sh   # fast baseline subset
```

### Per-domain grey gates

Fast unit/integration gates for the neutral pipeline and the scene-linear
sliders, each on a hand-rolled or fixture DNG:

```bash
src/scripts/test_synthetic_grey.sh    # neutral pipeline + flatness invariants
src/scripts/test_grey_adjustments.sh  # closed-form predictors per slider + ACR parity
src/scripts/test_grey_dcp.sh          # DCP code-path coverage (CM1/2, FM1/2, PGTM)
```

### Rust core tests

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib            # ~840 lib tests (70 ignored, fixture-gated)
cargo test -p raw-core --features test-support   # lib + integration, fixture-free
```

### CPU↔GPU parity gate (raw-core vs the WGSL kernels)

Every WGSL kernel in `raw-gpu` mirrors a raw-core Rust stage, and each one has a
test that runs both and compares the buffers. `cargo test -p raw-wasm --features gpu`
extends that to the whole chain, diffing the `render_bytes_gpu` u8 surface against
the CPU `render_bytes` reference on the committed synthetic grey DNG.

```bash
cd src/raw-pipeline
cargo test -p raw-gpu                      # ~180 per-kernel parity tests
cargo test -p raw-wasm --features gpu      # whole-chain render_bytes_gpu vs render_bytes
```

Both run in CI (#1973) on the `raw-gpu` job against Mesa **lavapipe**, a software
Vulkan adapter installed on the stock Linux runner — no GPU hardware needed. The
raw-gpu tests `.expect()` a GPU context rather than guarding, so a missing adapter
is ~180 loud failures rather than a skip; the raw-wasm gpu_render tests do keep a
`gpu_available()` soft-pass for developer boxes, and the CI job sets
`MAPLE_REQUIRE_GPU=1` to turn that soft-pass into a panic. A gate that quietly
compares nothing is the failure mode #1973 existed to remove.

lavapipe consumes naga's SPIR-V output, so this proves raw-core↔WGSL agreement but
not Metal-backend or browser-WebGPU behaviour; those still depend on running the
same suites locally on Metal and on the Apple UITest harness. Tracked in #2315.

### Developed-preview parity gate (API develop path)

`src/raw-pipeline/raw-ffi/tests/develop_preview_parity.rs` (#1964) CIEDE2000-
diffs the **API FFI developed 1280px preview** (`maple_render_develop_jpeg_to_file`,
the self-hosted `display-preview` stage's extern) against the **reference
develop** — the same `render_from_raw_with_quality_and_source` (AMaZE) that
`maple-cli batch` runs, downscaled with the identical `resize_long_edge`. Both
platforms develop through the shared `raw-core`, so the only expected delta is
the candidate's JPEG q82 round-trip; a wider delta means a develop-path wiring
regression (wrong demosaic, orientation double-bake, resize filter, or a
mis-applied XMP model) that the `maple-cli`-vs-ACR and Apple-Metal gates don't
cover. Reuses the single diff implementation (`compare_images.py`); budgets are
inline one-way-ratchet constants. Skip-passes when the RAW fixture or
`python3`+numpy/PIL/colour (the `compare_images.py` deps) are absent.

```bash
cd src/raw-pipeline
cargo test -p raw-ffi --test develop_preview_parity -- --nocapture
```

### CI

`.github/workflows/raw-pipeline.yml` runs the **`rust-tests`** job
(`cargo test -p raw-core --features test-support` plus the three grey gates,
added in #1082), a **`build-raw-ffi`** host-compile gate, the **`raw-gpu`** job
(the `--features gpu` compile gates, `check_wgsl.sh` naga validation, and the
CPU↔GPU parity suites above on lavapipe), and the
**`color-pipeline`** job. `.github/workflows/cross.yml` runs the
**`codegen-drift`** gate (confirming `tools/codegen.sh` outputs match the
committed Swift/TS/SCSS/WGSL) and the **`format-check`** job (runs Prettier
`--check` on changed files including `.ts`, `.html`, `.scss`, `.md`,
`.yaml`). When fixtures are absent (CI without the gitignored RAWs), every
fixture-gated harness skip-passes with a "skipping" message and exit 0, so
CI doesn't fail spuriously.

The Apple `MapleUITests` visual harness (live SwiftUI canvas vs. committed
PNG golden, CIEDE2000) and the slider-matrix harness run locally — see the
root `CLAUDE.md` § "UITest visual harness."

---

## Diagnostic tools

These are manual diagnostics. They don't gate CI — the gates live in
`src/scripts/test_color_pipeline.sh` and the per-domain `test_*.sh` scripts.
The tools below help attribute a residual to a specific operator class
(sharpening vs LUT vs highlight recovery vs local tone), which the scalar
mean/p95/max metrics can't do.

### `residual_diff.py` — per-pixel residual + frequency split

Pure-Python harness that takes two PNGs and emits signed per-pixel residual
maps plus a Gaussian frequency split. Use it when a scalar regression /
improvement appears in `compare_images.py` and you need to know **where**
the residual lives.

```bash
python3 src/scripts/residual_diff.py CAND.png REF.png \
    --out OUTDIR --register --factor-out-gain
```

The script:

1. Lanczos-resizes the smaller image to match the larger one (lossless
   direction).
2. Optionally registers via phase correlation (integer-pixel shift on luma).
3. Optionally fits a single global gain+offset per channel and removes it
   before computing residuals — so spatial residuals aren't masked by a
   global brightness/contrast offset (the fit is reported separately).
4. Masks a configurable border rim (default 2% per edge) — registration is
   worst at frame edges, and the residual maps render the rim as mid-gray
   sentinel so the masked region is obviously not "no diff."
5. Writes:
   - `summary.txt` — dimensions, registration drift, gain/offset, MAE, RMSE,
     ΔE2000 mean/median/p95, low-freq MAE, high-freq MAE, low/total ratio.
   - `residual_luma.png` — signed luma residual. 128 = zero diff, brighter =
     reference-higher. The most informative single output.
   - `residual_r.png`, `_g.png`, `_b.png` — per-channel signed.
   - `residual_lowpass.png` / `residual_highpass.png` — luma view of the
     residual after / minus a σ=4 Gaussian. Low-frequency residual is what
     a 1-D LUT or tone-curve tweak can fix; high-frequency residual is the
     domain of capture sharpening / deconvolution.
   - `delta_e_heatmap.png` — ΔE2000 per pixel, black → red → white-hot
     colormap, clipped at ΔE=20. Border rim painted mid-gray.
   - `value_scatter.csv` — for each integer value 0-255 per channel, the
     p5/p50/p95 of reference values at pixels with that candidate value
     (within `--bin-window`, default ±2). Spread = per-image scatter that a
     1-D map cannot resolve.

How to read the outputs:

- **High `residual_luma.png` structure on edges/textures, flat in smooth
  areas** → the residual is high-frequency. Look at capture sharpening
  (stage 10) or the post-AgX unsharp (stage 21). Confirm against the
  high-freq MAE in the summary.
- **Concentrated in the brightest regions** → highlight recovery / shoulder
  rolloff.
- **Smooth low-frequency field** → local tone, clarity, or the LUT itself.
  Confirm against the low-freq MAE.
- **Wide spread in `value_scatter.csv`** at common candidate values → the
  defect is per-pixel context-dependent and a 1-D map cannot fix it. A 3-D
  LUT or a spatial operator is required.

The harness handles the test_0000 / test_0003 fixtures (the high-spread
cases that motivated #391) cleanly. Example reading on test_0000
post-Look + post-AgX:

```
overall metrics:
  MAE  (mean abs delta, sRGB units, per-channel-averaged):  32.51
  RMSE (root mean squared, sRGB units):                     42.26
  dE2000 mean / median / p95:                               12.85 / 9.55 / 33.66

frequency split (Gaussian sigma=4 low/high):
  low-freq MAE (the LUT's domain):     27.95
  high-freq MAE (sharpening's domain): 9.76
  low/total ratio:                      0.74
```

This is what #392 (capture sharpening tuning) consumes to score its work
against the high-freq MAE specifically, instead of blending it with the
low-freq color metrics.

Requires `numpy`, `Pillow`, `scipy`, `colour-science` (all already pinned
in `src/scripts/requirements.txt`; `scipy` was newly added for this tool).
The script is a diagnostic only — no CI gate.

## Manual passkey QA

Run after any change to the auth code paths.

- [ ] Fresh server: claim with email + passkey on Mac, sign in on iPhone.
- [ ] Owner generates invite, second user joins from another machine.
- [ ] Member cannot reach `/settings/users` (web) / `ManageUsersView` (Apple).
- [ ] Removing one of two passkeys works; removing the last is blocked.
- [ ] Sign out, kill server, restart, sign in: refresh token still valid.
- [ ] Refresh-token reuse (manually replay an old refresh): subsequent refresh attempts fail; user is signed out.
