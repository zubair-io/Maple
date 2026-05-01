#!/usr/bin/env python3
"""Integration test for stage_diff.py: diffing a trace against itself
must produce all-zero ΔE. Diffing two intentionally different traces
must produce non-zero ΔE on the differing stage AND the worst-mean
annotation surfaces the difference.

Run: python3 src/scripts/stage_diff_test.py
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import imageio.v3 as iio


REPO_ROOT = Path(__file__).resolve().parents[2]


def write_synthetic_exr(path: Path, color: tuple[float, float, float]) -> None:
    """Write a 4×4 RGB float32 EXR filled with a single color.

    If imageio.v3 doesn't write a float32 EXR on this platform (some
    installs default to a Pillow-backed uint8 path), fall back to the
    OpenEXR python binding."""
    arr = np.full((4, 4, 3), color, dtype=np.float32)
    try:
        iio.imwrite(str(path), arr)
        # Read back and confirm float32 — if Pillow downcast, fall back.
        readback = iio.imread(str(path))
        if readback.dtype != np.float32:
            raise ValueError(f"imageio returned {readback.dtype}, falling back")
    except Exception:
        # Fallback: write via the OpenEXR binding.
        import OpenEXR, Imath
        h = OpenEXR.Header(4, 4)
        h["channels"] = {
            ch: Imath.Channel(Imath.PixelType(Imath.PixelType.FLOAT))
            for ch in ("R", "G", "B")
        }
        out = OpenEXR.OutputFile(str(path), h)
        out.writePixels({
            "R": arr[:, :, 0].tobytes(),
            "G": arr[:, :, 1].tobytes(),
            "B": arr[:, :, 2].tobytes(),
        })
        out.close()


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        a = Path(tmp) / "a"
        b = Path(tmp) / "b"
        a.mkdir()
        b.mkdir()
        # Stage 1 same in both, stage 2 different.
        write_synthetic_exr(a / "01_same.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(b / "01_same.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(a / "02_different.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(b / "02_different.exr", (0.6, 0.5, 0.5))

        result = subprocess.run(
            ["python3", str(REPO_ROOT / "src/scripts/stage_diff.py"), str(a), str(b)],
            capture_output=True, text=True, check=True,
        )
        out = result.stdout
        print(out)

        # Parse the two stage rows.
        lines = [l for l in out.splitlines() if l.startswith("01_") or l.startswith("02_")]
        assert len(lines) == 2, f"expected 2 stage rows, got {len(lines)}: {lines}"

        same_row = next(l for l in lines if "01_same" in l)
        diff_row = next(l for l in lines if "02_different" in l)

        # Mean ΔE column is field index 1 (0-based) when split on whitespace.
        same_mean = float(same_row.split()[1])
        diff_mean = float(diff_row.split()[1])

        assert same_mean < 0.01, f"identical stages should have ΔE ≈ 0, got {same_mean}"
        assert diff_mean > 1.0, f"differing stages should have ΔE > 1, got {diff_mean}"

        # Worst-stage annotation
        assert "worst-mean stage: 02_different" in out, \
            f"expected '02_different' as worst stage, got: {out}"

    print("stage_diff_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
