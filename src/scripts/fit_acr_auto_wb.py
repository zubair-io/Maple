#!/usr/bin/env python3
"""Recover ACR's Auto white balance (temperature, tint) per reference fixture.

ACR writes only `crs:WhiteBalance="Auto"` into the wb_auto.xmp sidecars, never
the pair it resolved. This script recovers it from the render: Maple renders
the fixture at a candidate pair (`maple-cli render --profile neutral`, preview
demosaic for speed), `compare_images.diff` gives the per-channel bias against
`test-fixtures/references/<stem>/down/wb_auto.png`, and a damped Newton step
moves temperature on the blue-minus-red bias and tint on the green-minus-mean
bias until the three channel biases agree (a pure exposure/tone residual, no
cast). Feeds `ACR_AUTO` in raw-core's `auto_adjustments_awb_fixture_tests.rs`
(#2247). Starting points are each fixture's as-shot reading.

Usage: src/scripts/fit_acr_auto_wb.py [test_0017 ...]   (default: all)
Env:   MAPLE_CLI (release maple-cli), MAPLE_FIT_WORK (scratch dir)
"""
import json, os, subprocess, sys, warnings
warnings.filterwarnings("ignore")
import pathlib
ROOT = str(pathlib.Path(__file__).resolve().parents[2])
CLI = os.environ.get("MAPLE_CLI", f"{ROOT}/src/raw-pipeline/target/release/maple-cli")
sys.path.insert(0, f"{ROOT}/src/scripts")
import compare_images
WORK = os.environ.get("MAPLE_FIT_WORK", "/tmp/maple-acr-auto-fit"); os.makedirs(WORK, exist_ok=True)
os.makedirs(WORK, exist_ok=True)

def render(stem, raw, t, tint, ref="wb_auto"):
    base = open(f"{ROOT}/test-fixtures/references/{stem}/xmp/baseline.xmp").read()
    xmp = base.replace('crs:WhiteBalance="As Shot"', f'crs:WhiteBalance="Custom" crs:Temperature="{t:.0f}" crs:Tint="{tint:.1f}"')
    assert xmp != base
    xp = f"{WORK}/{stem}.xmp"; open(xp, "w").write(xmp)
    png = f"{WORK}/{stem}.png"
    subprocess.run([CLI, "render", f"{ROOT}/test-fixtures/raws/{raw}", "--params", xp, "--out", png, "--profile", "neutral", "--demosaic", "preview"], check=True, capture_output=True)
    d = compare_images.diff(png, f"{ROOT}/test-fixtures/references/{stem}/down/{ref}.png")
    return d["mean_deltaE"], d["bias_r"], d["bias_g"], d["bias_b"]

def fit(stem, raw, t0, tint0):
    mired = 1e6 / t0; tint = tint0
    best = None
    # numerical derivatives once, then damped Newton on the two decoupled errors
    de, r, g, b = render(stem, raw, 1e6 / mired, tint)
    hist = [(1e6 / mired, tint, de, r, g, b)]
    d_m = 15.0; d_tint = 10.0
    _, r1, g1, b1 = render(stem, raw, 1e6 / (mired + d_m), tint)
    det_dm = ((b1 - r1) - (b - r)) / d_m
    _, r2, g2, b2 = render(stem, raw, 1e6 / mired, tint + d_tint)
    deg_dt = ((g2 - (r2 + b2) / 2) - (g - (r + b) / 2)) / d_tint
    for _ in range(6):
        e_t = b - r; e_g = g - (r + b) / 2
        if abs(det_dm) > 1e-6: mired -= 0.8 * e_t / det_dm
        if abs(deg_dt) > 1e-6: tint -= 0.8 * e_g / deg_dt
        mired = max(1e6 / 12000, min(1e6 / 2000, mired)); tint = max(-150, min(150, tint))
        de, r, g, b = render(stem, raw, 1e6 / mired, tint)
        hist.append((1e6 / mired, tint, de, r, g, b))
    best = min(hist, key=lambda h: h[2])
    return best, hist

FIX = {
 "test_0017": ("test_0017.dng", 5178, 3.9), "test_0006": ("test_0006.DNG", 3753, 18.3),
 "test_0007": ("test_0007.DNG", 3753, 18.3), "test_0011": ("test_0011.ARW", 6776, 34.2),
 "test_0012": ("test_0012.raf", 4737, 18.7), "test_0014": ("test_0014.NEF", 5244, 1.1),
 "test_0003": ("test_0003.CR2", 4946, 3.0), "test_0013": ("test_0013.DNG", 5182, 6.2),
 "test_0000": ("test_0000.DNG", 5508, -1.9), "test_0002": ("test_0002.dng", 4522, -43.8),
 "test_0010": ("test_0010.CR2", 4958, 16.3), "test_0009": ("test_0009.CR2", 4897, 15.6),
 "test_0018": ("test_0018.dng", 6504, 10.5), "test_0019": ("test_0019.dng", 5283, 40.7),
 "test_0005": ("test_0005.RAF", 4885, 24.5), "test_0008": ("test_0008.RAF", 5078, 39.9),
 "test_0020": ("test_0020.dng", 6504, 10.5), "test_0015": ("test_0015.dng", 3409, -101.5),
 "test_0004": ("test_0004.fff", 9659, 179.8),
}
names = sys.argv[1:] or list(FIX)
for stem in names:
    raw, t0, tint0 = FIX[stem]
    try:
        best, hist = fit(stem, raw, t0, tint0)
        print(f"{stem} ACR-auto fit: {best[0]:.0f} K / {best[1]:.1f}  (meanΔE {best[2]:.2f}, bias r {best[3]:+.3f} g {best[4]:+.3f} b {best[5]:+.3f}); start {t0}/{tint0} ΔE {hist[0][2]:.2f}", flush=True)
    except Exception as e:
        print(f"{stem} FAILED: {e}", flush=True)
