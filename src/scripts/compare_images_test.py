#!/usr/bin/env python3
"""Tests for compare_images.diff(). Run: python3 src/scripts/compare_images_test.py

Synthetic-image checks:
  * return-key stability (the harness depends on these exact keys)
  * identical images -> ~zero deltaE everywhere
  * a localized (red, highlight) shift surfaces in the right zone + hue bin
    and stays ~zero elsewhere (attribution)
  * population-weighted mean of zone means reconstructs the global mean
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare_images as ci


def _write(path, arr_u8):
    Image.fromarray(arr_u8, "RGB").save(path)


def _checker_highlight_red(h=64, w=64):
    """Neutral mid-grey background (L*~50, MID zone); a bright reddish block
    (L*~77, HIGHLIGHT zone, red/orange hue) in one quadrant. The block color
    is chosen so it lands in the highlight L* band AND carries real chroma —
    a pure bright red (230,40,40) is only L*~50 and would fall in MID."""
    img = np.full((h, w, 3), 120, dtype=np.uint8)        # neutral mid grey
    img[: h // 2, : w // 2] = (250, 170, 160)            # bright reddish (highlight)
    return img


def test_return_keys():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "a.png"
        _write(p, _checker_highlight_red())
        out = ci.diff(str(p), str(p))
        for k in ("mean_deltaE", "p95_deltaE", "max_deltaE",
                  "bias_r", "bias_g", "bias_b", "n_pixels"):
            assert k in out, f"missing key {k}"
        assert out["mean_deltaE"] < 1e-3, out["mean_deltaE"]


def test_attribution():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        cand = ref.copy()
        # Perturb ONLY the bright-red block (highlight zone, red hue).
        cand[:32, :32, 0] = 200          # pull red down -> color shift there
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True, hue_bins=12)

        # The grey background (mid zone, neutral hue) must be ~untouched.
        assert out["zones"]["mid"]["mean_deltaE"] < 0.5, out["zones"]["mid"]
        # The highlight zone (where the red block lives) must light up.
        assert out["zones"]["highlight"]["mean_deltaE"] > 3.0, out["zones"]["highlight"]
        # Some chromatic hue bin must carry the error; the neutral bucket must not.
        max_bin = max((b for b in out["hue_bins"]["bins"] if b["n"] > 0),
                      key=lambda b: b["mean_deltaE"])
        assert max_bin["mean_deltaE"] > 3.0, max_bin
        assert out["hue_bins"]["neutral"]["mean_deltaE"] < 0.5, out["hue_bins"]["neutral"]


def test_zone_self_consistency():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        rng = np.random.default_rng(0)
        cand = np.clip(ref.astype(np.int16) + rng.integers(-15, 15, ref.shape),
                       0, 255).astype(np.uint8)
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True)
        zones = [z for z in out["zones"].values() if z.get("n", 0) > 0]
        total = sum(z["n"] for z in zones)
        recon = sum(z["mean_deltaE"] * z["n"] for z in zones) / total
        assert abs(recon - out["mean_deltaE"]) < 1e-3, (recon, out["mean_deltaE"])


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all compare_images tests passed")


if __name__ == "__main__":
    main()
