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
