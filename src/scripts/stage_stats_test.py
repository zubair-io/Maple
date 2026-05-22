#!/usr/bin/env python3
"""Integration test for stage_stats.py: write a synthetic-known EXR,
run the tool, assert the JSON it emits has the expected structure +
values.

Smoke-grade — proves the tool runs end-to-end, the EXR loader works,
the metric shape matches what downstream consumers expect, and the
sRGB-primaries luma-weight switch fires on the right stage names.

Run: python3 src/scripts/stage_stats_test.py

Companion to src/scripts/stage_diff_test.py.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import imageio.v3 as iio


REPO_ROOT = Path(__file__).resolve().parents[2]
TOOL = REPO_ROOT / "src/scripts/stage_stats.py"


def write_synthetic_exr(path: Path, color: tuple[float, float, float],
                        size: tuple[int, int] = (4, 4)) -> None:
    """Write an `(H, W, 3)` float32 EXR filled with a single colour.

    Mirrors `stage_diff_test.write_synthetic_exr`: tries imageio.v3
    first, falls back to the OpenEXR binding when imageio's Pillow
    backend would downcast to uint8."""
    h, w = size
    arr = np.full((h, w, 3), color, dtype=np.float32)
    try:
        iio.imwrite(str(path), arr)
        readback = iio.imread(str(path))
        if readback.dtype != np.float32:
            raise ValueError(f"imageio returned {readback.dtype}, falling back")
    except Exception:
        import OpenEXR, Imath
        hdr = OpenEXR.Header(w, h)
        hdr["channels"] = {
            ch: Imath.Channel(Imath.PixelType(Imath.PixelType.FLOAT))
            for ch in ("R", "G", "B")
        }
        out = OpenEXR.OutputFile(str(path), hdr)
        out.writePixels({
            "R": arr[:, :, 0].tobytes(),
            "G": arr[:, :, 1].tobytes(),
            "B": arr[:, :, 2].tobytes(),
        })
        out.close()


def run_tool(dump_dir: Path, json_out: Path) -> str:
    """Invoke stage_stats.py and return stdout. Raises on non-zero exit."""
    result = subprocess.run(
        ["python3", str(TOOL), str(dump_dir), "--json", str(json_out)],
        capture_output=True, text=True, check=True,
    )
    return result.stdout


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        dump = Path(tmp) / "stages"
        dump.mkdir()

        # Stage 01: neutral mid-gray. Drift should be 0, OOG should be 0,
        # no shadow / no highlight pixels.
        write_synthetic_exr(dump / "01_neutral.exr", (0.5, 0.5, 0.5))
        # Stage 02: out-of-gamut on R (negative), B (>1). Tool must report.
        write_synthetic_exr(dump / "02_oog.exr", (-0.1, 0.5, 1.2))
        # Stage 03: pure-red asymmetric — drift_all is non-zero.
        write_synthetic_exr(dump / "03_red.exr", (0.9, 0.1, 0.1))
        # Stage 17 named '17_srgb_linear' so the Rec.709 luma-weight branch
        # fires. Use a colour that lands in shadow under Rec.709 but NOT
        # Rec.2020, to prove the switch works.
        #   Rec.2020 Y(0, 0, 0.5) = 0.0593 * 0.5 = 0.0297 → shadow (<0.05)
        #   Rec.709  Y(0, 0, 0.5) = 0.0722 * 0.5 = 0.0361 → shadow (<0.05)
        # Both flag shadow → can't differentiate. Pick a colour where the
        # weights differ enough to matter:
        #   Rec.2020 Y(0.10, 0.04, 0.0) = 0.0263 + 0.0271 = 0.0534 → above
        #   Rec.709  Y(0.10, 0.04, 0.0) = 0.0213 + 0.0286 = 0.0499 → below
        # Different shadow_mask → different drift_shadows population.
        write_synthetic_exr(dump / "17_srgb_linear.exr", (0.10, 0.04, 0.0))

        json_out = Path(tmp) / "stats.json"
        out = run_tool(dump, json_out)
        print(out)
        assert json_out.is_file(), f"--json file not written: {json_out}"

        metrics = json.loads(json_out.read_text())
        assert set(metrics.keys()) == {"01_neutral", "02_oog", "03_red", "17_srgb_linear"}, \
            f"unexpected stages: {list(metrics.keys())}"

        # Neutral patch: zero drift, zero OOG, luma_primaries=rec2020.
        n = metrics["01_neutral"]
        assert n["luma_primaries"] == "rec2020", \
            f"expected rec2020 weights, got {n['luma_primaries']}"
        assert n["drift_all"]["rg"] < 1e-6, \
            f"neutral drift should be ~0, got {n['drift_all']['rg']}"
        assert n["out_of_gamut"]["neg_pixels"] == 0
        assert n["out_of_gamut"]["supra_pixels"] == 0

        # OOG patch: negative R AND >1 B everywhere.
        o = metrics["02_oog"]
        assert o["out_of_gamut"]["neg_pixels"] == 16  # 4x4 = all pixels
        assert o["out_of_gamut"]["supra_pixels"] == 16
        assert o["out_of_gamut"]["neg_pct"] == 100.0

        # Red patch: non-zero drift across all pixels.
        r = metrics["03_red"]
        assert abs(r["drift_all"]["rg"] - 0.8) < 1e-5, \
            f"R-G drift on red patch should be 0.8, got {r['drift_all']['rg']}"

        # sRGB-named stage uses Rec.709 luma weights.
        s = metrics["17_srgb_linear"]
        assert s["luma_primaries"] == "rec709", \
            f"expected rec709 weights on 17_srgb_linear, got {s['luma_primaries']}"

        # Output table must contain a row for every stage.
        for stage in metrics:
            assert stage in out, f"stage {stage} missing from table output:\n{out}"

    print("stage_stats_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
