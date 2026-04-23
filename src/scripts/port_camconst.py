#!/usr/bin/env python3
"""Port per-body linearization data from RawTherapee's camconst.json into
a Maple-owned Rust static table.

Only a fixed allowlist of camera bodies is extracted (the ones we have
fixtures for or otherwise care about). Matrices are NOT extracted here —
rawler already supplies those. Output is at
src/raw-pipeline/raw-core/src/camera_calibration/camconst_ranges.rs.

Legal note: the numerical values are sensor measurements (facts) which
are not themselves copyrightable. The *compilation* of them is. The Rust
file we emit is Maple's own compilation, with a per-entry attribution
comment citing the RT source line and version.

We do NOT redistribute camconst.json itself. Only the derived Rust file.

Usage:
    python3 port_camconst.py           # read default path, emit Rust
    python3 port_camconst.py --source /path/to/camconst.json --out /path/to/rs
    python3 port_camconst.py --help
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_SOURCE = Path(
    "/Applications/RawTherapee.app/Contents/Resources/share/camconst.json"
)
DEFAULT_OUT = (
    Path(__file__).resolve().parents[1]
    / "raw-pipeline"
    / "raw-core"
    / "src"
    / "camera_calibration"
    / "camconst_ranges.rs"
)
DEFAULT_INFO_PLIST = Path(
    "/Applications/RawTherapee.app/Contents/Info.plist"
)

# Exact names to match (case-insensitive) against the camconst.json
# "make_model" strings. Matching is done against each string in the list
# (some entries are arrays).
TARGET_BODIES: list[tuple[str, str]] = [
    ("Canon",      "Canon EOS 5DS R"),
    ("Hasselblad", "Hasselblad L3D-100c"),
    ("Hasselblad", "Hasselblad H2D-39"),
    ("Panasonic",  "Panasonic DMC-LX2"),
]


# ─── Parsing: strip non-standard JSON comments ──────────────────────────

# Block comments /* ... */ may span lines. Line comments // ... run to end
# of line. Neither is legal in RFC 8259 JSON but RT uses them freely.
#
# Important: we must NOT strip inside string literals. The conservative
# approach is to run a character-level tokenizer that respects "..."
# string state.

def strip_json_comments(text: str) -> str:
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    string_quote = ""
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == string_quote:
                in_string = False
            i += 1
            continue
        if c == '"' or c == "'":
            in_string = True
            string_quote = c
            out.append(c)
            i += 1
            continue
        # Not in string — look for comments.
        if c == "/" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "/":
                # Line comment — skip to newline.
                j = text.find("\n", i)
                if j < 0:
                    break
                i = j
                continue
            if nxt == "*":
                # Block comment — skip to closing */.
                j = text.find("*/", i + 2)
                if j < 0:
                    raise ValueError("unterminated /* ... */ block comment")
                i = j + 2
                continue
        out.append(c)
        i += 1
    return "".join(out)


# ─── Extraction: ranges / raw_crop / masked_areas ───────────────────────

@dataclass
class Bucket:
    iso_lo: int
    iso_hi: int
    # Either a scalar level, or a list of per-channel levels.
    levels: int | list[int]
    source_iso_field: object = None  # For attribution.

@dataclass
class Crop:
    x: int
    y: int
    w: int
    h: int

@dataclass
class Body:
    make: str
    model: str
    black: list[Bucket] = field(default_factory=list)
    white: list[Bucket] = field(default_factory=list)
    raw_crop: Crop | None = None
    masked_areas: list[Crop] = field(default_factory=list)
    source_snippet: str = ""     # Truncated pretty-printed JSON for citation.
    skipped_notes: list[str] = field(default_factory=list)


def _iso_to_range(iso_field: object) -> tuple[int, int]:
    """Normalize an "iso" field into a (lo, hi) inclusive range. The field
    can be a single int (a single ISO), a list of ints (a set of ISOs — we
    take min/max), or absent.

    RT's ISO-bucket lookup picks the closest ISO, but for our downstream
    use a simple "is x in [lo, hi]" test is sufficient: we keep the buckets
    in file order and first-match wins.
    """
    if iso_field is None:
        return (0, 10_000_000)  # all-ISO bucket
    if isinstance(iso_field, int):
        return (int(iso_field), int(iso_field))
    if isinstance(iso_field, list):
        if not iso_field:
            return (0, 10_000_000)
        iso_ints = [int(x) for x in iso_field]
        return (min(iso_ints), max(iso_ints))
    raise ValueError(f"unsupported iso field: {iso_field!r}")


def _parse_levels(levels_field: object) -> int | list[int]:
    """Return either a single int (scalar) or a list of ints (per channel).
    Per RT docs, arrays can be 1, 3 (G2 == G1), or 4 elements. We preserve
    their length and let the Rust side handle the per-channel mapping.
    """
    if isinstance(levels_field, int):
        return int(levels_field)
    if isinstance(levels_field, list):
        return [int(x) for x in levels_field]
    raise ValueError(f"unsupported levels field: {levels_field!r}")


def _parse_ranges_field(ranges: dict, key: str) -> list[Bucket]:
    """Parse ranges.black or ranges.white into a list of buckets."""
    if key not in ranges:
        return []
    v = ranges[key]
    # Shape 1: scalar ("black": 10)
    if isinstance(v, int):
        return [Bucket(iso_lo=0, iso_hi=10_000_000, levels=int(v),
                       source_iso_field=None)]
    # Shape 2: per-channel array ("black": [10, 10, 10, 10])
    if isinstance(v, list) and v and all(isinstance(x, (int, float)) for x in v):
        return [Bucket(iso_lo=0, iso_hi=10_000_000,
                       levels=[int(x) for x in v], source_iso_field=None)]
    # Shape 3: per-ISO buckets [{"iso": ..., "levels": ...}, ...]
    if isinstance(v, list) and v and isinstance(v[0], dict):
        buckets: list[Bucket] = []
        for bucket in v:
            if "levels" not in bucket:
                continue
            iso_lo, iso_hi = _iso_to_range(bucket.get("iso"))
            try:
                levels = _parse_levels(bucket["levels"])
            except ValueError:
                continue  # skip weird shapes, don't crash
            buckets.append(Bucket(
                iso_lo=iso_lo, iso_hi=iso_hi, levels=levels,
                source_iso_field=bucket.get("iso"),
            ))
        return buckets
    return []


def _parse_crop_field(v: object) -> tuple[Crop | None, list[str]]:
    """Parse the raw_crop field. Returns (crop, notes). We only handle the
    simple [x, y, w, h] form; the multi-aspect variant is recorded in notes
    and skipped.
    """
    notes: list[str] = []
    if v is None:
        return (None, notes)
    if isinstance(v, list) and len(v) == 4 and all(isinstance(x, (int, float)) for x in v):
        x, y, w, h = [int(k) for k in v]
        # RT's convention allows negative w/h to mean "cut from right/bottom".
        # We skip these rather than guess sensor dimensions.
        if w <= 0 or h <= 0:
            notes.append(f"skipped raw_crop with non-positive w/h: {v!r}")
            return (None, notes)
        return (Crop(x=x, y=y, w=w, h=h), notes)
    # Multi-aspect { "frame": [...], "crop": [...] }
    if isinstance(v, list) and v and isinstance(v[0], dict):
        notes.append("skipped raw_crop multi-aspect variant (not supported)")
        return (None, notes)
    notes.append(f"skipped raw_crop of unrecognized shape: {type(v).__name__}")
    return (None, notes)


def _parse_masked_areas_field(v: object) -> tuple[list[Crop], list[str]]:
    """Parse the masked_areas field. Returns (crops, notes). We accept the
    flat tetrads form (4 or 8 ints); skip the multi-aspect variant.

    Note RT's semantics for masked_areas are ABSOLUTE edge coordinates:
      [top, left, bottom, right] — we preserve them as (x=left, y=top,
       w=right-left, h=bottom-top) for uniformity with Crop.
    """
    notes: list[str] = []
    if v is None:
        return ([], notes)
    if isinstance(v, list) and v and isinstance(v[0], dict):
        notes.append("skipped masked_areas multi-aspect variant")
        return ([], notes)
    if isinstance(v, list) and all(isinstance(x, (int, float)) for x in v):
        if len(v) % 4 != 0:
            notes.append(f"skipped masked_areas with wrong arity {len(v)}")
            return ([], notes)
        out: list[Crop] = []
        for i in range(0, len(v), 4):
            top, left, bottom, right = [int(v[i + j]) for j in range(4)]
            w = right - left
            h = bottom - top
            if w <= 0 or h <= 0:
                notes.append(
                    f"skipped degenerate masked_area (top={top}, left={left}, "
                    f"bottom={bottom}, right={right})"
                )
                continue
            out.append(Crop(x=left, y=top, w=w, h=h))
        return (out, notes)
    notes.append(f"skipped masked_areas of unrecognized shape: {type(v).__name__}")
    return ([], notes)


def _entry_matches(entry: dict, target_model: str) -> bool:
    mm = entry.get("make_model")
    tlo = target_model.lower()
    if isinstance(mm, str):
        return mm.lower() == tlo
    if isinstance(mm, list):
        return any(isinstance(m, str) and m.lower() == tlo for m in mm)
    return False


def extract(doc: dict, target_make: str, target_model: str) -> Body | None:
    body = Body(make=target_make, model=target_model)
    for entry in doc.get("camera_constants", []):
        if not _entry_matches(entry, target_model):
            continue
        # Found — fill in.
        body.source_snippet = json.dumps(entry, indent=2, ensure_ascii=False)
        ranges = entry.get("ranges", {}) or {}
        body.black = _parse_ranges_field(ranges, "black")
        body.white = _parse_ranges_field(ranges, "white")

        raw_crop = entry.get("raw_crop")
        if raw_crop is not None:
            crop, notes = _parse_crop_field(raw_crop)
            body.raw_crop = crop
            body.skipped_notes.extend(notes)

        masked = entry.get("masked_areas")
        if masked is not None:
            crops, notes = _parse_masked_areas_field(masked)
            body.masked_areas = crops
            body.skipped_notes.extend(notes)

        return body
    return None


# ─── Rendering: emit Rust source ───────────────────────────────────────

RUST_HEADER = """// SPDX-License-Identifier: GPL-3.0-or-later
//
// ****************************************************************************
// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Regenerate with: python3 src/scripts/port_camconst.py
//
// Source: RawTherapee camconst.json, RT {rt_version}.
// Source path at port time: {src_path}
// Upstream reference:
//   https://github.com/Beep6581/RawTherapee/blob/dev/rtengine/camconst.json
// Attribution and licensing: docs/licenses/rawtherapee-attribution.md.
//
// The numerical values below are sensor measurements (facts). Their
// organization into this Rust compilation is Maple's work. Each body entry
// cites the specific RT camconst.json line it was derived from.
// ****************************************************************************

#[allow(unused_imports)]
use super::{{BlackLevels, Crop, IsoBucket, Linearization, WhiteLevels}};

#[allow(clippy::type_complexity)]
pub(super) struct CamconstEntry {{
    pub make: &'static str,
    pub model: &'static str,
    pub data: Linearization,
}}

"""


def _render_levels(levels: int | list[int]) -> str:
    """Render a `BlackLevels`/`WhiteLevels` Rust literal."""
    if isinstance(levels, int):
        return f"BlackLevels::Single({int(levels)})"
    # Normalize to 4 channels: RT uses [R, G1, B] (G2 = G1) for 3-element
    # arrays; [R, G1, B, G2] for 4-element.
    arr = [int(x) for x in levels]
    if len(arr) == 1:
        # Treat a 1-element array as a scalar.
        return f"BlackLevels::Single({arr[0]})"
    if len(arr) == 3:
        # R, G1, B with G2 == G1.
        r, g1, b = arr
        g2 = g1
    elif len(arr) == 4:
        r, g1, b, g2 = arr
    else:
        # Unknown arity — skip into a Single using the minimum (conservative
        # for white; for black it's also fine).
        return f"BlackLevels::Single({min(arr)})"
    return f"BlackLevels::PerChannel([{r}, {g1}, {b}, {g2}])"


def _render_white_levels(levels: int | list[int]) -> str:
    return _render_levels(levels).replace("BlackLevels::", "WhiteLevels::")


def _render_iso_bucket(prefix: str, b: Bucket, render_levels) -> str:
    # Attribution: source iso field as-written.
    src = b.source_iso_field
    if src is None:
        src_comment = "all ISO"
    else:
        src_comment = f"iso={json.dumps(src)}"
    return (
        f"            IsoBucket {{ iso_range: ({b.iso_lo}, {b.iso_hi}), "
        f"value: {render_levels(b.levels)} }}, // {src_comment}"
    )


def _render_crop(c: Crop) -> str:
    return f"Crop {{ x: {c.x}, y: {c.y}, w: {c.w}, h: {c.h} }}"


def render_rust(bodies: list[Body], rt_version: str, src_path: Path) -> str:
    out: list[str] = [RUST_HEADER.format(rt_version=rt_version, src_path=src_path)]
    out.append(
        "pub(super) static CAMCONST_ENTRIES: &[CamconstEntry] = &[\n"
    )
    for body in bodies:
        out.append(f"    // ── {body.make} · {body.model} ──\n")
        if body.source_snippet:
            # Indent the JSON snippet as a block comment for per-entry citation.
            snippet_lines = body.source_snippet.splitlines()
            out.append("    // RT camconst.json source entry:\n")
            for line in snippet_lines[:40]:  # cap attribution to 40 lines
                out.append(f"    //     {line}\n")
            if len(snippet_lines) > 40:
                out.append("    //     ... (truncated)\n")
        if body.skipped_notes:
            for n in body.skipped_notes:
                out.append(f"    // NOTE: {n}\n")
        out.append("    CamconstEntry {\n")
        out.append(f"        make: \"{body.make}\",\n")
        out.append(f"        model: \"{body.model}\",\n")
        out.append("        data: Linearization {\n")
        # black
        if body.black:
            out.append("            black: &[\n")
            for b in body.black:
                out.append(
                    _render_iso_bucket("black", b, _render_levels) + "\n"
                )
            out.append("            ],\n")
        else:
            out.append("            black: &[],\n")
        # white
        if body.white:
            out.append("            white: &[\n")
            for b in body.white:
                out.append(
                    _render_iso_bucket("white", b, _render_white_levels) + "\n"
                )
            out.append("            ],\n")
        else:
            out.append("            white: &[],\n")
        # raw_crop
        if body.raw_crop is not None:
            out.append(
                f"            raw_crop: Some({_render_crop(body.raw_crop)}),\n"
            )
        else:
            out.append("            raw_crop: None,\n")
        # masked_areas
        if body.masked_areas:
            out.append("            masked_areas: &[\n")
            for c in body.masked_areas:
                out.append(f"                {_render_crop(c)},\n")
            out.append("            ],\n")
        else:
            out.append("            masked_areas: &[],\n")
        out.append("        },\n")
        out.append("    },\n\n")
    out.append("];\n")
    return "".join(out)


# ─── RT version detection ───────────────────────────────────────────────

def detect_rt_version(info_plist: Path | None) -> str:
    """Read the RT bundle's Info.plist CFBundleShortVersionString. Falls
    back to "unknown" if the plist is missing or unreadable.
    """
    if info_plist is None or not info_plist.exists():
        return "unknown"
    try:
        import plistlib
        with open(info_plist, "rb") as f:
            plist = plistlib.load(f)
        return (
            plist.get("CFBundleShortVersionString")
            or plist.get("CFBundleVersion")
            or "unknown"
        )
    except Exception as e:
        sys.stderr.write(f"warning: could not read RT version from {info_plist}: {e}\n")
        return "unknown"


# ─── Main ───────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Port per-body linearization data from RawTherapee's "
            "camconst.json into a Maple-owned Rust static table."
        )
    )
    p.add_argument(
        "--source", type=Path, default=DEFAULT_SOURCE,
        help=f"Path to camconst.json (default: {DEFAULT_SOURCE})",
    )
    p.add_argument(
        "--out", type=Path, default=DEFAULT_OUT,
        help=f"Output Rust file (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--info-plist", type=Path, default=DEFAULT_INFO_PLIST,
        help=(
            "Path to RawTherapee.app's Info.plist for version detection. "
            f"Default: {DEFAULT_INFO_PLIST}"
        ),
    )
    args = p.parse_args()

    if not args.source.exists():
        sys.stderr.write(
            f"error: source file does not exist: {args.source}\n"
            "Is RawTherapee 5.x installed in /Applications?\n"
        )
        return 2

    try:
        raw = args.source.read_text(encoding="utf-8")
    except Exception as e:
        sys.stderr.write(f"error: failed to read {args.source}: {e}\n")
        return 2

    rt_version = detect_rt_version(args.info_plist)

    try:
        cleaned = strip_json_comments(raw)
    except ValueError as e:
        sys.stderr.write(f"error: comment strip failed: {e}\n")
        return 3

    try:
        doc = json.loads(cleaned)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"error: JSON parse failed at line {e.lineno}, col {e.colno}: {e.msg}\n")
        return 3

    if "camera_constants" not in doc:
        sys.stderr.write(
            "error: parsed document has no 'camera_constants' array — "
            "format may have changed.\n"
        )
        return 3

    found: list[Body] = []
    missing: list[str] = []
    for make, model in TARGET_BODIES:
        body = extract(doc, make, model)
        if body is None:
            missing.append(model)
        else:
            found.append(body)

    print(f"RT version detected: {rt_version}")
    print(f"Total bodies in camconst.json: {len(doc['camera_constants'])}")
    print(f"Bodies found: {len(found)} of {len(TARGET_BODIES)}")
    for body in found:
        whiteLen = len(body.white)
        blackLen = len(body.black)
        print(
            f"  ✓ {body.make} · {body.model} "
            f"(black={blackLen} bucket(s), white={whiteLen} bucket(s), "
            f"raw_crop={'yes' if body.raw_crop else 'no'}, "
            f"masked_areas={len(body.masked_areas)})"
        )
        for note in body.skipped_notes:
            print(f"      note: {note}")
    if missing:
        print(f"Bodies absent: {len(missing)}")
        for m in missing:
            print(f"  ✗ {m}")

    # Emit Rust.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    rust = render_rust(found, rt_version, args.source)
    args.out.write_text(rust, encoding="utf-8")
    print(f"\nWrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
