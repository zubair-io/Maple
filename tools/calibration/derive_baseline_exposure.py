#!/usr/bin/env python3
"""Sweep MAPLE_BE_OVERRIDE values for one fixture, find the BE that
minimizes per-channel bias magnitude vs the ACR baseline reference.

Usage:
    derive_baseline_exposure.py <fixture.raw> <ref.png> \
        [--ev-min -1.5] [--ev-max 1.5] [--ev-step 0.1] \
        [--maple-cli <path>]

Output (stdout, single-line JSON):
    {
      "fixture":  "test-fixtures/raws/test_0010.CR2",
      "ref":      "test-fixtures/references/test_0010/down/baseline.png",
      "best_ev":  -0.4,
      "best_bias_max":  0.012,
      "best_bias_r":   -0.005,
      "best_bias_g":    0.003,
      "best_bias_b":   -0.012,
      "best_mean_de":   8.1,
      "sweep": [
        {"ev": -1.5, "bias_max": 0.21, "bias_r": -0.21, ...},
        ...
      ]
    }

Exit 0 on success; non-zero on render error or missing reference.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image
import colour

# Avoid Pillow's decompression-bomb heuristic on full-res ACR refs.
Image.MAX_IMAGE_PIXELS = None

REPO_ROOT = Path(__file__).resolve().parents[2]


def render_at(maple_cli: Path, fixture: Path, out_png: Path, ev: float) -> bool:
    """Run maple-cli render with MAPLE_BE_OVERRIDE=ev. Returns True on success."""
    env = os.environ.copy()
    env["MAPLE_BE_OVERRIDE"] = f"{ev:.4f}"
    result = subprocess.run(
        [str(maple_cli), "render", str(fixture), "--out", str(out_png)],
        env=env, capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"# render failed at ev={ev}: {result.stderr.strip()[:200]}", file=sys.stderr)
        return False
    return out_png.exists()


def diff(cand_png: Path, ref_png: Path) -> dict:
    """Return mean ΔE + per-channel bias for a candidate vs reference."""
    cand = Image.open(cand_png).convert("RGB")
    ref = Image.open(ref_png).convert("RGB")
    if cand.size != ref.size:
        cand = cand.resize(ref.size, Image.LANCZOS)
    cand_arr = np.asarray(cand, dtype=np.float32) / 255.0
    ref_arr = np.asarray(ref, dtype=np.float32) / 255.0
    cand_xyz = colour.sRGB_to_XYZ(cand_arr)
    ref_xyz = colour.sRGB_to_XYZ(ref_arr)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab = colour.XYZ_to_Lab(ref_xyz)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    bias = (cand_arr - ref_arr).mean(axis=(0, 1))
    return {
        "mean_de": float(np.mean(dE)),
        "bias_r": float(bias[0]),
        "bias_g": float(bias[1]),
        "bias_b": float(bias[2]),
        "bias_max": float(np.max(np.abs(bias))),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("fixture", type=Path)
    p.add_argument("ref", type=Path)
    p.add_argument("--ev-min", type=float, default=-1.5)
    p.add_argument("--ev-max", type=float, default=1.5)
    p.add_argument("--ev-step", type=float, default=0.1)
    p.add_argument(
        "--maple-cli", type=Path,
        default=REPO_ROOT / "src/raw-pipeline/target/release/maple-cli",
    )
    args = p.parse_args()

    if not args.fixture.exists():
        print(f"error: fixture not found: {args.fixture}", file=sys.stderr)
        return 2
    if not args.ref.exists():
        print(f"error: reference not found: {args.ref}", file=sys.stderr)
        return 2
    if not args.maple_cli.exists():
        print(f"error: maple-cli not found: {args.maple_cli}", file=sys.stderr)
        print(f"hint: run `cd src/raw-pipeline && cargo build --release -p maple-cli`", file=sys.stderr)
        return 2

    sweep = []
    ev = args.ev_min
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        while ev <= args.ev_max + 1e-6:
            cand = tmp / f"cand_{ev:+.2f}.png"
            ok = render_at(args.maple_cli, args.fixture, cand, ev)
            if not ok:
                ev += args.ev_step
                continue
            metrics = diff(cand, args.ref)
            metrics["ev"] = round(ev, 3)
            sweep.append(metrics)
            print(f"# ev={ev:+.2f}  bias=({metrics['bias_r']:+.3f},{metrics['bias_g']:+.3f},{metrics['bias_b']:+.3f})  mean_de={metrics['mean_de']:.2f}", file=sys.stderr)
            cand.unlink(missing_ok=True)
            ev += args.ev_step

    if not sweep:
        print("error: every render in the sweep failed", file=sys.stderr)
        return 3

    best = min(sweep, key=lambda r: r["bias_max"])
    out = {
        "fixture": str(args.fixture),
        "ref": str(args.ref),
        "best_ev": best["ev"],
        "best_bias_max": best["bias_max"],
        "best_bias_r": best["bias_r"],
        "best_bias_g": best["bias_g"],
        "best_bias_b": best["bias_b"],
        "best_mean_de": best["mean_de"],
        "sweep": sweep,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
