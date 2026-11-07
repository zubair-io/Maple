#!/usr/bin/env python3
"""Display-P3 vs sRGB consistency and wide-gamut retention for Auto and Neutral (#4741).

For every RAW fixture and each profile (auto, neutral) the pinned maple-cli
renders the sRGB and the Display-P3 output. Two quantities are measured on a
strided sample of the frame:

  * dE_in  - CIEDE2000 between the sRGB render and the P3 render rotated to
             sRGB, over the pixels the sRGB gamut compression leaves alone
             (Oklab chroma at or below COMPRESS_THRESHOLD of the sRGB hull for
             the Neutral P3 pixel; the design note's r = 1 set).
  * outside - the share of P3 output pixels whose linear sRGB value leaves the
             sRGB cube (wide-gamut data kept).

Gate (exit 1 on any failure): per fixture, Auto dE_in mean <= MAX_AUTO_DE_MEAN
and Auto outside share >= Neutral outside share - OUTSIDE_SLACK. A render
error, an empty fixture selection or a fixture with no r = 1 pixels fails.
Every render is kept under --work and its SHA-256 recorded in the row.

Usage: p3_auto_gamut_check.py --cli CLI --raw-dir DIR --work DIR [--filter S]
       [--stride N] [--json OUT.json]
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys

import colour
import numpy as np
from PIL import Image

from auto_profile_match import EXTENSIONS

Image.MAX_IMAGE_PIXELS = None

COMPRESS_THRESHOLD = 0.8
OUTSIDE_TOLERANCE = 2e-3
MAX_AUTO_DE_MEAN = 0.45
OUTSIDE_SLACK = 1e-4

M_SRGB_TO_P3 = np.array(
    [
        [0.8224620, 0.1775380, 0.0],
        [0.0331942, 0.9668058, 0.0],
        [0.0170826, 0.0723974, 0.9105199],
    ]
)
M_P3_TO_SRGB = np.linalg.inv(M_SRGB_TO_P3)
M1 = np.array(
    [
        [0.41222147, 0.53633254, 0.05144599],
        [0.21190350, 0.68069955, 0.10739696],
        [0.08830246, 0.28171884, 0.62997870],
    ]
)
M2 = np.array(
    [
        [0.21045426, 0.79361779, -0.00407205],
        [1.97799850, -2.42859221, 0.45059371],
        [0.02590404, 0.78277177, -0.80867577],
    ]
)
M1_INV = np.linalg.inv(M1)
M2_INV = np.linalg.inv(M2)


def decode(png: pathlib.Path, stride: int) -> np.ndarray:
    with Image.open(png) as im:
        rgb = np.asarray(im.convert("RGB"))[::stride, ::stride]
    return rgb.astype(np.float64) / 255.0


def p3_encoded_to_linear_srgb(encoded: np.ndarray) -> np.ndarray:
    return colour.cctf_decoding(encoded, function="sRGB") @ M_P3_TO_SRGB.T


def oklab(linear_srgb: np.ndarray) -> np.ndarray:
    return np.cbrt(linear_srgb @ M1.T) @ M2.T


def oklab_to_linear(lab: np.ndarray) -> np.ndarray:
    return ((lab @ M2_INV.T) ** 3) @ M1_INV.T


def in_unit_box(rgb: np.ndarray) -> np.ndarray:
    return np.all((rgb >= -1e-5) & (rgb <= 1.0 + 1e-5), axis=-1)


def below_srgb_knee(linear_srgb: np.ndarray) -> np.ndarray:
    probe = oklab(linear_srgb)
    probe[..., 1:] /= COMPRESS_THRESHOLD
    return in_unit_box(oklab_to_linear(probe)) & in_unit_box(linear_srgb)


def outside_srgb(linear_srgb: np.ndarray) -> np.ndarray:
    return np.any(
        (linear_srgb < -OUTSIDE_TOLERANCE) | (linear_srgb > 1.0 + OUTSIDE_TOLERANCE),
        axis=-1,
    )


def lab_of_encoded_srgb(encoded: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(encoded))


def delta_e(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return colour.delta_E(lab_of_encoded_srgb(a), lab_of_encoded_srgb(b), method="CIE 2000")


def render(cli: str, raw: pathlib.Path, out: pathlib.Path, profile: str, primaries: str):
    subprocess.run(
        [cli, "render", str(raw), "--out", str(out), "--profile", profile,
         "--target-primaries", primaries],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def stats(values: np.ndarray) -> dict:
    if values.size == 0:
        return {"n": 0, "mean": None, "p95": None, "max": None}
    return {
        "n": int(values.size),
        "mean": float(values.mean()),
        "p95": float(np.percentile(values, 95)),
        "max": float(values.max()),
    }


def sha256(path: pathlib.Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def measure(cli: str, raw: pathlib.Path, work: pathlib.Path, stride: int) -> dict:
    variants = [(profile, primaries) for profile in ("neutral", "auto") for primaries in ("srgb", "p3")]
    pngs = {v: work / f"{raw.stem}-{v[0]}-{v[1]}.png" for v in variants}
    for (profile, primaries), png in pngs.items():
        render(cli, raw, png, profile, primaries)
    renders = {v: decode(png, stride) for v, png in pngs.items()}
    in_gamut = below_srgb_knee(p3_encoded_to_linear_srgb(renders[("neutral", "p3")]))
    row = {
        "fixture": raw.name,
        "pixels": int(in_gamut.size),
        "in_gamut_share": float(in_gamut.mean()),
        "renders": {png.name: sha256(png) for png in pngs.values()},
    }
    for profile in ("neutral", "auto"):
        p3_linear = p3_encoded_to_linear_srgb(renders[(profile, "p3")])
        p3_as_srgb = colour.cctf_encoding(np.clip(p3_linear, 0.0, 1.0), function="sRGB")
        de = delta_e(renders[(profile, "srgb")], p3_as_srgb)
        row[profile] = {
            "dE_in_gamut": stats(de[in_gamut]),
            "outside_srgb_share": float(outside_srgb(p3_linear).mean()),
        }
    return row


def fixtures(raw_dir: pathlib.Path, needle: str):
    return sorted(
        p
        for p in raw_dir.iterdir()
        if p.suffix.lower() in EXTENSIONS and p.name.startswith("test_") and needle in p.name
    )


def table(rows: list) -> str:
    head = (
        "| fixture | r=1 share | Neutral dE mean | Neutral dE p95 | Auto dE mean | Auto dE p95 "
        "| Neutral outside sRGB | Auto outside sRGB |\n|---|---|---|---|---|---|---|---|"
    )

    def fmt(v):
        return "n/a" if v is None else f"{v:.3f}"

    lines = [
        f"| {r['fixture']} | {r['in_gamut_share']:.3f} | {fmt(r['neutral']['dE_in_gamut']['mean'])} "
        f"| {fmt(r['neutral']['dE_in_gamut']['p95'])} | {fmt(r['auto']['dE_in_gamut']['mean'])} "
        f"| {fmt(r['auto']['dE_in_gamut']['p95'])} | {r['neutral']['outside_srgb_share']:.4f} "
        f"| {r['auto']['outside_srgb_share']:.4f} |"
        for r in rows
    ]
    return "\n".join([head, *lines])


def failures(row: dict) -> list:
    if "error" in row:
        return [row["error"]]
    auto, neutral = row["auto"], row["neutral"]
    mean = auto["dE_in_gamut"]["mean"]
    outside = auto["outside_srgb_share"]
    floor = neutral["outside_srgb_share"] - OUTSIDE_SLACK
    checks = [
        (mean is None, "no r = 1 pixels to measure"),
        (mean is not None and mean > MAX_AUTO_DE_MEAN, f"Auto dE mean {mean} > {MAX_AUTO_DE_MEAN}"),
        (outside < floor, f"Auto outside-sRGB share {outside:.6f} < Neutral - {OUTSIDE_SLACK} ({floor:.6f})"),
    ]
    return [message for failed, message in checks if failed]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--raw-dir", required=True, type=pathlib.Path)
    ap.add_argument("--work", required=True, type=pathlib.Path)
    ap.add_argument("--filter", default="")
    ap.add_argument("--stride", type=int, default=8)
    ap.add_argument("--json", type=pathlib.Path)
    args = ap.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    rows = []
    selected = fixtures(args.raw_dir, args.filter)
    if not selected:
        print(f"no RAW fixtures selected in {args.raw_dir}", file=sys.stderr)
        return 1
    for raw in selected:
        try:
            rows.append(measure(args.cli, raw, args.work, args.stride))
        except subprocess.CalledProcessError:
            print(f"render failed: {raw.name}", file=sys.stderr)
            rows.append({"fixture": raw.name, "error": "render failed"})
    for row in rows:
        row["failures"] = failures(row)
    good = [r for r in rows if "error" not in r]
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2))
    print(table(good))
    failed = [r for r in rows if r["failures"]]
    for row in failed:
        print(f"FAIL {row['fixture']}: {'; '.join(row['failures'])}")
    print(f"P3 Auto gamut gate: {len(rows) - len(failed)}/{len(rows)} fixtures pass")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
