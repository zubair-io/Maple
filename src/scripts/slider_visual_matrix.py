#!/usr/bin/env python3
"""slider_visual_matrix.py — eyeball-friendly diagnostic for slider sanity.

For one fixture, renders every committed slider XMP through maple-cli
and composites the results into a single PNG grid alongside the
matching ACR-rendered references. Designed to surface broken sliders
*visually* — averaging metrics over a 10-megapixel frame can hide
exactly the localized artifacts (skin-tone magenta, edge halos, banded
gradients) that draw the eye when the slider misbehaves.

Layout (one row per slider, columns left-to-right):
  | slider name | Maple min | Maple max | gap | ACR min | ACR max |

Continuous sliders (exposure, contrast, ...) get min+max columns. Single-
extreme sliders (sharpen_masking_max, nr_luminance_max, wb_*) get one
column on each side. Top row is the baseline pair (Maple baseline vs ACR
baseline) so you can spot any *no-edits* divergence first.

Output goes to test-fixtures/diagnostics/<fixture>_<timestamp>.png so
you can keep the artifact next to the changes that produced it.

Usage:
    python3 src/scripts/slider_visual_matrix.py                  # default test_0002
    python3 src/scripts/slider_visual_matrix.py test_0003
    python3 src/scripts/slider_visual_matrix.py --thumb-width 320

Cross-links:
  - calibrate_color_pipeline.sh — the per-channel bias gate
  - test_color_pipeline.sh      — the embedded-preview parity gate
  - SliderMatrixUITests.swift   — the live-app variant (XCUITest)
This script complements those: numbers + visual side-by-side.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import colour

Image.MAX_IMAGE_PIXELS = None

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "test-fixtures" / "references" / "manifest.json"
RAWS_DIR = REPO_ROOT / "test-fixtures" / "raws"
REFS_DIR = REPO_ROOT / "test-fixtures" / "references"
DIAG_DIR = REPO_ROOT / "test-fixtures" / "diagnostics"
MAPLE_CLI = REPO_ROOT / "src" / "raw-pipeline" / "target" / "release" / "maple-cli"

# Slider grouping for the layout. Keep the order semantic, not alphabetical
# — your eye reads top-to-bottom in the panel order. Continuous sliders
# show {min, max}; single-extreme show what's available.
SLIDER_GROUPS: list[tuple[str, list[tuple[str, list[str]]]]] = [
    ("Baseline & WB", [
        ("baseline", []),  # special: rendered alone in the top row
        ("temperature", ["min", "max"]),
        ("tint", ["min", "max"]),
        ("wb_auto", []),
        ("wb_daylight", []),
        ("wb_cloudy", []),
        ("wb_shade", []),
        ("wb_tungsten", []),
        ("wb_flash", []),
    ]),
    ("Basic", [
        ("exposure", ["min", "max"]),
        ("contrast", ["min", "max"]),
        ("highlights", ["min", "max"]),
        ("shadows", ["min", "max"]),
        ("whites", ["min", "max"]),
        ("blacks", ["min", "max"]),
    ]),
    ("Presence", [
        ("vibrance", ["min", "max"]),
        ("saturation", ["min", "max"]),
        ("clarity", ["min", "max"]),
        ("texture", ["min", "max"]),
        ("dehaze", ["min", "max"]),
    ]),
    ("Detail", [
        ("sharpen_amount", ["min", "max"]),
        ("sharpen_radius", ["min", "max"]),
        ("sharpen_detail", ["min", "max"]),
        ("sharpen_masking", ["max"]),
        ("nr_luminance", ["max"]),
        ("nr_color", ["min", "max"]),
    ]),
]


def case_name(slider: str, extreme: str) -> str:
    """Return the manifest case name for a (slider, extreme) pair."""
    if extreme == "":
        return slider  # baseline, wb_auto, wb_daylight, ...
    return f"{slider}_{extreme}"


def load_manifest_for(stem: str) -> dict[str, dict]:
    """Return {case_name: manifest_entry} for the given fixture stem."""
    manifest = json.loads(MANIFEST.read_text())
    out: dict[str, dict] = {}
    for case in manifest["cases"]:
        if case["name"].startswith(f"{stem}/"):
            out[case["name"].split("/", 1)[1]] = case
    return out


def render_candidate(raw: Path, xmp: Path, out: Path) -> bool:
    """Run maple-cli render. Returns True on success."""
    res = subprocess.run(
        [str(MAPLE_CLI), "render", str(raw), "--params", str(xmp), "--out", str(out)],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(f"  render failed for {xmp.name}: {res.stderr.strip()}",
              file=sys.stderr)
        return False
    return True


def thumb(img: Image.Image, target_w: int) -> Image.Image:
    """Lanczos resize preserving aspect."""
    w, h = img.size
    h_out = int(round(h * target_w / w))
    return img.resize((target_w, h_out), Image.LANCZOS)


def diff_de_inline(cand_path: Path, ref_path: Path) -> float | None:
    """Mean CIEDE2000 between candidate and reference. Returns None on error."""
    try:
        c = Image.open(cand_path).convert("RGB")
        r = Image.open(ref_path).convert("RGB")
        if c.size != r.size:
            c = c.resize(r.size, Image.LANCZOS)
        # Downsize to 512 px long edge for fast diff. CIEDE2000's sensitivity
        # at the per-pixel level doesn't change much under 2x downsample.
        scale = 512.0 / max(c.size)
        if scale < 1.0:
            new = (max(1, int(c.size[0] * scale)), max(1, int(c.size[1] * scale)))
            c = c.resize(new, Image.LANCZOS)
            r = r.resize(new, Image.LANCZOS)
        cand = np.asarray(c, dtype=np.float32) / 255.0
        ref = np.asarray(r, dtype=np.float32) / 255.0
        c_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand))
        r_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref))
        return float(np.mean(colour.delta_E(c_lab, r_lab, method="CIE 2000")))
    except Exception as e:
        print(f"  diff failed: {e}", file=sys.stderr)
        return None


def label_cell(img: Image.Image, text: str, font: ImageFont.ImageFont) -> Image.Image:
    """Add a black label bar above the image with the given text."""
    bar_h = 18
    new = Image.new("RGB", (img.size[0], img.size[1] + bar_h), (16, 16, 16))
    new.paste(img, (0, bar_h))
    draw = ImageDraw.Draw(new)
    draw.text((4, 2), text, fill=(220, 220, 220), font=font)
    return new


def get_font() -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, 11)
            except Exception:
                pass
    return ImageFont.load_default()


def get_label_font() -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, 14)
            except Exception:
                pass
    return ImageFont.load_default()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("fixture", nargs="?", default="test_0002",
                   help="fixture stem (default: test_0002)")
    p.add_argument("--thumb-width", type=int, default=240,
                   help="per-cell thumbnail width in px (default 240)")
    p.add_argument("--out", type=Path, default=None,
                   help="output PNG path (default: diagnostics/<fixture>_<timestamp>.png)")
    args = p.parse_args()

    if not MAPLE_CLI.exists():
        print(f"Building maple-cli ...", file=sys.stderr)
        res = subprocess.run(
            ["cargo", "build", "--release", "--bin", "maple-cli"],
            cwd=REPO_ROOT / "src" / "raw-pipeline",
        )
        if res.returncode != 0:
            return 2

    cases = load_manifest_for(args.fixture)
    if not cases:
        print(f"No manifest cases for {args.fixture}", file=sys.stderr)
        return 1

    # Find the RAW (extension may vary).
    raw_path: Path | None = None
    for entry in cases.values():
        candidate = Path(entry["raw"])
        if candidate.exists():
            raw_path = candidate
            break
    if raw_path is None:
        print(f"No RAW for {args.fixture} on disk (checked {RAWS_DIR})",
              file=sys.stderr)
        return 1

    print(f"slider_visual_matrix: fixture={args.fixture}", file=sys.stderr)
    print(f"slider_visual_matrix: raw={raw_path.name}", file=sys.stderr)
    print(f"slider_visual_matrix: cases={len(cases)}", file=sys.stderr)

    tmp = Path(tempfile.mkdtemp(prefix="maple-svm-"))
    cell_font = get_font()
    label_font = get_label_font()

    # Render every Maple candidate. Each into tmp/<case>.png.
    rendered: dict[str, Path] = {}
    for cname, entry in sorted(cases.items()):
        out = tmp / f"{cname}.png"
        if render_candidate(Path(entry["raw"]), Path(entry["xmp"]), out):
            rendered[cname] = out
            print(f"  ok  {cname}", file=sys.stderr)

    # Build rows. Skip rows where neither Maple nor ACR has any cell.
    cell_w = args.thumb_width
    label_col_w = 130
    gap_w = 24

    rows: list[list[Image.Image | None]] = []  # 4 cols (or 3): [maple_min, maple_max, ref_min, ref_max]
    row_titles: list[str] = []
    section_breaks: list[int] = []  # indices in `rows` where we want section dividers

    def thumb_cell(path: Path | None, label: str, de: float | None = None) -> Image.Image | None:
        if path is None or not path.exists():
            return None
        try:
            im = Image.open(path).convert("RGB")
        except Exception:
            return None
        t = thumb(im, cell_w)
        cell_label = label
        if de is not None:
            cell_label = f"{label}  ΔE {de:.1f}"
        return label_cell(t, cell_label, cell_font)

    for section_name, sliders in SLIDER_GROUPS:
        if rows:
            section_breaks.append(len(rows))
        for slider, extremes in sliders:
            if not extremes:
                # Single-cell row (baseline, wb_*).
                cname = case_name(slider, "")
                ref_outputs = cases.get(cname, {}).get("outputs", [])
                ref_path = next(
                    (Path(o["png"]) for o in ref_outputs
                     if o["resolution"] == "down" and Path(o["png"]).exists()),
                    None
                )
                cand = rendered.get(cname)
                de = diff_de_inline(cand, ref_path) if (cand and ref_path) else None
                row = [
                    thumb_cell(cand, "Maple", de),
                    None,
                    thumb_cell(ref_path, "ACR"),
                    None,
                ]
                if any(c is not None for c in row):
                    rows.append(row)
                    row_titles.append(slider)
                continue
            # Two-cell row (min/max).
            row: list[Image.Image | None] = [None, None, None, None]
            for col, extreme in [(0, "min"), (1, "max")]:
                if extreme not in extremes:
                    continue
                cname = case_name(slider, extreme)
                ref_outputs = cases.get(cname, {}).get("outputs", [])
                ref_path = next(
                    (Path(o["png"]) for o in ref_outputs
                     if o["resolution"] == "down" and Path(o["png"]).exists()),
                    None
                )
                cand = rendered.get(cname)
                de = diff_de_inline(cand, ref_path) if (cand and ref_path) else None
                row[col] = thumb_cell(cand, f"Maple {extreme}", de)
                row[2 + col] = thumb_cell(ref_path, f"ACR {extreme}")
            if any(c is not None for c in row):
                rows.append(row)
                row_titles.append(slider)

    if not rows:
        print("No renderable rows — check fixtures + manifest", file=sys.stderr)
        return 1

    # Compute composite dimensions.
    # Each row: label_col_w + 2*cell_w + gap_w + 2*cell_w
    # Cell height: from the first non-None cell.
    sample_cell = next(c for row in rows for c in row if c is not None)
    cell_h = sample_cell.size[1]
    row_h = cell_h + 4
    header_h = 36
    section_h = 26

    total_w = label_col_w + 2 * cell_w + gap_w + 2 * cell_w + 8
    total_h = header_h + len(rows) * row_h + len(section_breaks) * section_h + 12

    out_img = Image.new("RGB", (total_w, total_h), (28, 28, 28))
    draw = ImageDraw.Draw(out_img)

    # Header.
    draw.text(
        (12, 8),
        f"{args.fixture}  ·  Maple slider matrix vs ACR  ·  {datetime.now():%Y-%m-%d %H:%M}",
        fill=(240, 240, 240), font=label_font
    )
    draw.text(
        (12, 22),
        f"raw={raw_path.name}  ·  thumb {cell_w}px  ·  ΔE per cell vs matching ACR ref",
        fill=(180, 180, 180), font=cell_font
    )

    y = header_h
    section_idx = 0
    section_iter = iter(SLIDER_GROUPS)
    current_section = next(section_iter)
    section_label_drawn = False
    section_emit_at = 0  # row index where the next section header should land

    # Walk in lockstep with section_breaks.
    section_break_set = set([0] + section_breaks)
    section_names = [s[0] for s in SLIDER_GROUPS]
    section_ptr = 0

    for ri, (row, title) in enumerate(zip(rows, row_titles)):
        if ri in section_break_set:
            # Draw section header.
            draw.rectangle((0, y, total_w, y + section_h), fill=(40, 40, 50))
            draw.text(
                (12, y + 6),
                section_names[section_ptr].upper(),
                fill=(200, 200, 230), font=label_font
            )
            section_ptr += 1
            y += section_h

        # Row label.
        draw.text((12, y + cell_h // 2 - 8), title,
                  fill=(220, 220, 220), font=cell_font)

        x = label_col_w
        # Maple cells.
        for col in (0, 1):
            cell = row[col]
            if cell is not None:
                out_img.paste(cell, (x, y))
            x += cell_w
        # Gap.
        x += gap_w
        # ACR cells.
        for col in (2, 3):
            cell = row[col]
            if cell is not None:
                out_img.paste(cell, (x, y))
            x += cell_w

        y += row_h

    # Output path.
    if args.out:
        out_path = args.out
    else:
        DIAG_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = DIAG_DIR / f"{args.fixture}_{ts}.png"

    out_img.save(out_path, optimize=True)
    print(f"slider_visual_matrix: wrote {out_path}", file=sys.stderr)
    print(f"slider_visual_matrix: dims {out_img.size[0]}x{out_img.size[1]}",
          file=sys.stderr)
    print(str(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
