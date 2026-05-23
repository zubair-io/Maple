#!/usr/bin/env python3
"""Convert Adobe DNG Camera Profiles (.dcp) to Maple's bundled profile format.

Walks a directory of Adobe DCP files (e.g.
`/Library/Application Support/Adobe/CameraRaw/CameraProfiles/Adobe Standard/`),
parses each as a TIFF-IFD with DNG custom tags, and emits a single compact
binary at `src/raw-pipeline/raw-core/src/color/profiles/profiles.bin`. The
binary is loaded at runtime by `profile_loader.rs` (compiled into the crate
via `include_bytes!`).

Why bundle our own format, not Adobe's .dcp binaries verbatim:
  - Strongest derived-work license posture. We re-encode a subset of fields
    (color matrices, illuminants, lens-disambiguated camera key, optionally
    the HueSatMap LUT) in a Maple-specific layout. We do NOT ship Adobe's
    binary file unchanged.
  - We drop ProfileToneCurve and ProfileLookTable. Maple's view transform
    (AgX) replaces the per-profile tone curve; the universal "look" curve
    (separate ticket) replaces PLT.

Bundle format (little-endian throughout):
  Header (16 bytes):
    [0..4]   magic        b"MDCP"
    [4..6]   version      u16  (=1)
    [6..8]   flags        u16  (=0; reserved for future per-bundle metadata)
    [8..12]  num_profiles u32
    [12..16] reserved     u32  (=0)

  Per profile record:
    [0..2]    ucm_len      u16  (utf-8 byte length, ≤ 65535)
    [2..2+N]  ucm          N bytes (no NUL terminator)
    [N]       has_flags    u8   bit0=CM1 bit1=CM2 bit2=FM1 bit3=FM2
                                bit4=HSM1 bit5=HSM2 (bit6/7 reserved)
    [N+1]     reserved     u8   (=0)
    [N+2..]   illum1       u16  DNG CalibrationIlluminant code, 0 if absent
              illum2       u16  same
              reserved     u16  (=0)
              (each present matrix:  9×f32 = 36 bytes; order CM1, CM2, FM1, FM2)
              hsm_h        u16  (0 if no HSM)
              hsm_s        u16
              hsm_v        u16
              hsm_encoding u8   0=Linear, 1=sRGB; ignored when no HSM
              reserved     u8   (=0)
              (if has_hsm1: h*s*v*3 f32 = 12*h*s*v bytes)
              (if has_hsm2: h*s*v*3 f32 = 12*h*s*v bytes)
              u32 baseline_exposure_offset_bits  IEEE754 bits of f32 (0 if absent)

Usage:
  python3 src/scripts/convert_adobe_dcps.py \
      --src "/Library/Application Support/Adobe/CameraRaw/CameraProfiles/Adobe Standard" \
      --out src/raw-pipeline/raw-core/src/color/profiles/profiles.bin

  # Include HSM (HueSatMap data) — adds ~72 MB to the bundle:
  python3 src/scripts/convert_adobe_dcps.py --src ... --out ... --include-hsm

HSM is OFF by default (`--include-hsm` is opt-in). Most Maple fixtures need
matrices only to drop ΔE below 8; HSM is a follow-up refinement that costs
~72 MB in the repo.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import struct
import sys
import warnings
from pathlib import Path
from typing import Optional

# Silence tifffile's noisy per-file "missing data offset tag" warnings. DCPs
# legitimately omit StripOffsets/StripByteCounts because they don't carry an
# image — only metadata. tifffile reports it for every file otherwise.
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

try:
    import tifffile  # type: ignore
except ImportError:
    sys.stderr.write(
        "tifffile is required: pip install -r src/scripts/requirements.txt\n"
    )
    sys.exit(2)


MAGIC = b"MDCP"
VERSION = 1


# ── Tag helpers ───────────────────────────────────────────────────────────────


def srational_to_floats(values: tuple) -> list[float]:
    """SRATIONAL tiff tag stores pairs of (num, den). Return a flat float list."""
    out: list[float] = []
    for i in range(0, len(values), 2):
        num = values[i]
        den = values[i + 1]
        if den == 0:
            out.append(0.0)
        else:
            out.append(num / den)
    return out


def read_matrix(tags, name: str) -> Optional[list[float]]:
    """Return a 9-float row-major matrix at `name`, or None if absent/malformed."""
    if name not in tags:
        return None
    v = tags[name].value
    fs = srational_to_floats(v)
    if len(fs) < 9:
        return None
    return fs[:9]


def write_matrix(buf: bytearray, m: list[float]) -> None:
    for v in m:
        buf += struct.pack("<f", float(v))


def write_hsm_data(buf: bytearray, values) -> None:
    # tifffile returns ndarray for FLOAT[*] tags.
    for v in values:
        buf += struct.pack("<f", float(v))


# ── Duplicate-UCM dedup ───────────────────────────────────────────────────────
#
# Adobe ships multiple .dcp files with the same UniqueCameraModel for ~44 of
# the 1,447 bodies. Two flavours of duplication:
#
#   * "Adobe Standard v2" vs "Adobe Standard" (and "Adobe_Standard_v2" vs
#     "Adobe_Standard"): the v2 variant is the newer Adobe-calibrated profile
#     for that body. We prefer v2.
#   * "Adobe Standard" vs "Camera Default": Adobe ships a copy of the
#     vendor's own (non-Adobe) matrices under "Camera Default" for ACR's
#     default-selection UI. We're bundling Adobe Standard, so we drop the
#     "Camera Default" duplicate.
#
# Ranking returns a sortable tuple where LOWER wins (so deterministic
# `min(...)` picks the preferred file). The tuple is (tier, basename) so
# ties fall back to lexicographic filename — keeps output stable across
# machines and Adobe updates.


def dcp_preference(filename: str) -> tuple[int, str]:
    """Return a (tier, basename) sort key — lower tier wins.

    tier 0: "Adobe Standard v2" / "Adobe_Standard_v2" (newer Adobe-calibrated)
    tier 1: "Adobe Standard"     / "Adobe_Standard"   (older Adobe-calibrated)
    tier 2: "Camera Default"                          (vendor matrices)
    tier 9: anything else (no Adobe Standard suffix at all)
    """
    name = filename.lower()
    if re.search(r"adobe[_ ]standard[_ ]v2", name):
        return (0, filename)
    if re.search(r"camera default", name):
        return (2, filename)
    if re.search(r"adobe[_ ]standard", name):
        return (1, filename)
    return (9, filename)


# ── Per-file extraction ───────────────────────────────────────────────────────


def read_ucm(path: Path) -> Optional[str]:
    """Read just the `UniqueCameraModel` tag from a DCP.

    Cheap probe used to bucket duplicate-UCM files before serialization, so
    we only parse and emit the preferred candidate per UCM. Returns None
    when the file has no UCM tag, can't be opened, or the UCM is empty /
    too long to encode.
    """
    try:
        with tifffile.TiffFile(str(path)) as tif:
            tags = {tag.name: tag for tag in tif.pages[0].tags}
    except Exception:  # noqa: BLE001
        return None
    if "UniqueCameraModel" not in tags:
        return None
    ucm = tags["UniqueCameraModel"].value
    if isinstance(ucm, bytes):
        ucm = ucm.decode("utf-8", errors="replace")
    ucm = ucm.strip("\x00")
    if not ucm:
        return None
    if len(ucm.encode("utf-8")) > 0xFFFF:
        return None
    return ucm


def extract_profile(path: Path, include_hsm: bool) -> Optional[bytes]:
    """Parse one DCP and return its serialized profile record bytes.

    Returns None when the file lacks a UniqueCameraModel tag (no usable key).
    """
    with tifffile.TiffFile(str(path)) as tif:
        page = tif.pages[0]
        tags = {tag.name: tag for tag in page.tags}

    if "UniqueCameraModel" not in tags:
        return None
    ucm = tags["UniqueCameraModel"].value
    if isinstance(ucm, bytes):
        ucm = ucm.decode("utf-8", errors="replace")
    ucm = ucm.strip("\x00")  # trim trailing NULs some writers leave behind
    ucm_bytes = ucm.encode("utf-8")
    if len(ucm_bytes) > 0xFFFF:
        return None  # absurdly long; skip

    cm1 = read_matrix(tags, "ColorMatrix1")
    cm2 = read_matrix(tags, "ColorMatrix2")
    fm1 = read_matrix(tags, "ForwardMatrix1")
    fm2 = read_matrix(tags, "ForwardMatrix2")
    illum1 = int(tags["CalibrationIlluminant1"].value) if "CalibrationIlluminant1" in tags else 0
    illum2 = int(tags["CalibrationIlluminant2"].value) if "CalibrationIlluminant2" in tags else 0

    # HSM (per DNG 1.6 § 6.6): three LONGs (h, s, v) and the float array(s).
    hsm_h = hsm_s = hsm_v = 0
    hsm1_values = None
    hsm2_values = None
    hsm_encoding = 0  # 0 = Linear, 1 = sRGB; default Linear per DNG spec.
    if include_hsm and "ProfileHueSatMapDims" in tags:
        dims = tags["ProfileHueSatMapDims"].value
        if len(dims) >= 3:
            h, s, v = int(dims[0]), int(dims[1]), int(dims[2])
            expected = h * s * v * 3
            if h > 0 and s > 0 and v > 0 and expected > 0:
                if "ProfileHueSatMapData1" in tags:
                    arr1 = tags["ProfileHueSatMapData1"].value
                    if len(arr1) == expected:
                        hsm1_values = arr1
                if "ProfileHueSatMapData2" in tags:
                    arr2 = tags["ProfileHueSatMapData2"].value
                    if len(arr2) == expected:
                        hsm2_values = arr2
                if hsm1_values is not None or hsm2_values is not None:
                    hsm_h, hsm_s, hsm_v = h, s, v
                if "ProfileHueSatMapEncoding" in tags:
                    hsm_encoding = int(tags["ProfileHueSatMapEncoding"].value)
                    if hsm_encoding not in (0, 1):
                        hsm_encoding = 0

    # BaselineExposureOffset (DNG § 6.2.15 / tag 51109). Only 5/1447 ship it;
    # default 0 when absent.
    be_offset = 0.0
    if "BaselineExposureOffset" in tags:
        v = tags["BaselineExposureOffset"].value
        if isinstance(v, (tuple, list)) and len(v) >= 2 and v[1] != 0:
            be_offset = v[0] / v[1]
        elif isinstance(v, (int, float)):
            be_offset = float(v)

    flags = 0
    if cm1 is not None:
        flags |= 0x01
    if cm2 is not None:
        flags |= 0x02
    if fm1 is not None:
        flags |= 0x04
    if fm2 is not None:
        flags |= 0x08
    if hsm1_values is not None:
        flags |= 0x10
    if hsm2_values is not None:
        flags |= 0x20

    rec = bytearray()
    rec += struct.pack("<H", len(ucm_bytes))
    rec += ucm_bytes
    rec += struct.pack("<BB", flags, 0)
    rec += struct.pack("<HHH", illum1 & 0xFFFF, illum2 & 0xFFFF, 0)
    for m in (cm1, cm2, fm1, fm2):
        if m is not None:
            write_matrix(rec, m)
    rec += struct.pack("<HHH", hsm_h, hsm_s, hsm_v)
    rec += struct.pack("<BB", hsm_encoding & 0xFF, 0)
    if hsm1_values is not None:
        write_hsm_data(rec, hsm1_values)
    if hsm2_values is not None:
        write_hsm_data(rec, hsm2_values)
    rec += struct.pack("<f", float(be_offset))
    return bytes(rec)


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--src",
        required=True,
        help="Path to the Adobe Standard/ directory containing .dcp files.",
    )
    ap.add_argument(
        "--out",
        required=True,
        help="Output binary file path (typically "
        "src/raw-pipeline/raw-core/src/color/profiles/profiles.bin).",
    )
    ap.add_argument(
        "--include-hsm",
        action="store_true",
        help="Include ProfileHueSatMap data in the bundle (adds ~72 MB; "
        "default off to keep the repo small — matrices alone fix the catastrophic ΔE).",
    )
    ap.add_argument(
        "--manifest",
        default=None,
        help="Optional: also emit a human-readable JSON manifest of every "
        "bundled profile (UCM, illuminants, FM presence, HSM dims). For debugging.",
    )
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    if not src.is_dir():
        sys.stderr.write(f"error: source directory not found: {src}\n")
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in src.iterdir() if p.suffix.lower() == ".dcp")
    if not files:
        sys.stderr.write(f"error: no .dcp files found in {src}\n")
        return 1

    # ── Phase 1: bucket every .dcp by UCM, then pick the preferred file per
    # UCM via `dcp_preference`. This makes duplicate handling deterministic
    # and logged — without it, `profile_loader::parse_bundle` would silently
    # last-write-wins whichever record happened to come second on disk.
    buckets: dict[str, list[Path]] = {}
    no_ucm: list[Path] = []
    for f in files:
        ucm = read_ucm(f)
        if ucm is None:
            no_ucm.append(f)
            continue
        buckets.setdefault(ucm, []).append(f)

    selected: list[tuple[str, Path]] = []  # (ucm, chosen file)
    discarded: list[tuple[str, str, str]] = []  # (ucm, chosen, discarded)
    for ucm, candidates in sorted(buckets.items()):
        chosen = min(candidates, key=lambda p: dcp_preference(p.name))
        selected.append((ucm, chosen))
        for c in candidates:
            if c != chosen:
                discarded.append((ucm, chosen.name, c.name))

    if discarded:
        print(f"Deduplicated {len(discarded)} duplicate-UCM file(s):")
        for ucm, chosen, dropped in discarded[:20]:
            print(f"  {ucm!r}: kept {chosen!r}, dropped {dropped!r}")
        if len(discarded) > 20:
            print(f"  ... and {len(discarded) - 20} more")

    # ── Phase 2: serialize only the selected winners.
    records: list[bytes] = []
    skipped: list[tuple[str, str]] = [(f.name, "no UniqueCameraModel") for f in no_ucm]
    manifest_entries: list[dict] = []

    for _ucm, f in selected:
        try:
            rec = extract_profile(f, include_hsm=args.include_hsm)
        except Exception as e:  # noqa: BLE001
            skipped.append((f.name, f"parse error: {e}"))
            continue
        if rec is None:
            skipped.append((f.name, "no UniqueCameraModel"))
            continue
        records.append(rec)
        if args.manifest:
            # Re-parse to capture manifest fields cheaply.
            with tifffile.TiffFile(str(f)) as tif:
                tags = {t.name: t for t in tif.pages[0].tags}
            ucm = tags["UniqueCameraModel"].value
            if isinstance(ucm, bytes):
                ucm = ucm.decode("utf-8", errors="replace")
            manifest_entries.append(
                {
                    "ucm": ucm.strip("\x00"),
                    "filename": f.name,
                    "illum1": int(tags["CalibrationIlluminant1"].value)
                    if "CalibrationIlluminant1" in tags
                    else 0,
                    "illum2": int(tags["CalibrationIlluminant2"].value)
                    if "CalibrationIlluminant2" in tags
                    else 0,
                    "has_fm": "ForwardMatrix1" in tags,
                    "has_hsm": "ProfileHueSatMapData1" in tags,
                }
            )

    if not records:
        sys.stderr.write("error: no profiles emitted\n")
        return 1

    header = MAGIC + struct.pack("<HHII", VERSION, 0, len(records), 0)
    body = b"".join(records)
    out.write_bytes(header + body)

    print(f"Wrote {len(records)} profiles to {out} ({(len(header) + len(body)) / 1024:.1f} KB)")
    if skipped:
        print(f"Skipped {len(skipped)} files:")
        for name, why in skipped[:10]:
            print(f"  {name}: {why}")
        if len(skipped) > 10:
            print(f"  ... and {len(skipped) - 10} more")

    if args.manifest:
        import json

        with open(args.manifest, "w") as f:
            json.dump(manifest_entries, f, indent=2)
        print(f"Wrote manifest: {args.manifest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
