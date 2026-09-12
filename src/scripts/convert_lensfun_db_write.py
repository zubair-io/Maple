#!/usr/bin/env python3
"""Writers for convert_lensfun_db.py: the `db.bin` binary table, ATTRIBUTION.md and COVERAGE.md.

Binary layout (little-endian throughout, every name is a u32 index into the string table):

    header:  magic b"MLFN" | u16 version = 1 | u16 reserved | u32 n_strings | u32 n_mounts
             | u32 n_cameras | u32 n_lenses | u8[12] db_commit (ascii, NUL-padded)
             | u8[10] db_date "YYYY-MM-DD"
    strings: n_strings x (u16 len | utf8 bytes)
    mount:   u32 name | u16 n_compat | n_compat x u32 name
    camera:  u32 maker | u32 model | u16 n_variants | n_variants x u32 name
             | u32 mount (index into mounts) | f32 crop
    lens:    u32 maker | u32 model | u16 n_names | n_names x u32 | u16 n_mounts
             | n_mounts x u32 mount index | f32 crop | f32 aspect
             | u8 kind (0 rectilinear, 1 other) | u16 n_dist | n_dist x dist
             | u16 n_tca | n_tca x tca | u16 n_vig | n_vig x vig
    dist:    f32 focal | f32 real_focal | f32 scale | f32[3] even | f32[2] odd
    tca:     f32 focal | f32 real_focal | 2 x (f32 scale | f32[3] even | f32[2] odd)
    vig:     f32 focal | f32 aperture | f32 distance | f32[3] k

Header field offsets: magic 0, version 4, reserved 6, n_strings 8, n_mounts 12,
n_cameras 16, n_lenses 20, db_commit 24, db_date 36; the string table starts at byte 46.
"""

from __future__ import annotations

import struct
from pathlib import Path

MAGIC = b"MLFN"
VERSION = 1
SOURCE_URL = "https://github.com/lensfun/lensfun"
SPEC = "docs/superpowers/specs/2026-09-12-lensfun-bundled-lens-corrections-design.md"
CROP_TOLERANCE = 0.02


class Strings:
    """Interning string table; `index` returns a stable u32 for every distinct string."""

    def __init__(self) -> None:
        self.table: list = []
        self.indices: dict = {}

    def index(self, value: str) -> int:
        existing = self.indices.get(value)
        if existing is not None:
            return existing
        self.indices[value] = len(self.table)
        self.table.append(value)
        return self.indices[value]

    def encode(self) -> bytes:
        out = bytearray()
        for value in self.table:
            data = value.encode("utf-8")
            if len(data) > 0xFFFF:
                raise ValueError(f"string too long for u16 length: {value[:40]!r}…")
            out += struct.pack("<H", len(data)) + data
        return bytes(out)


def radial_terms(terms: dict) -> bytes:
    return struct.pack("<6f", terms["scale"], *terms["even"], *terms["odd"])


def encode_distortion(sample: dict) -> bytes:
    return struct.pack("<2f", sample["focal"], sample["real_focal"]) + radial_terms(sample)


def encode_tca(sample: dict) -> bytes:
    return (
        struct.pack("<2f", sample["focal"], sample["real_focal"])
        + radial_terms(sample["red"])
        + radial_terms(sample["blue"])
    )


def encode_vignetting(sample: dict) -> bytes:
    return struct.pack("<6f", sample["focal"], sample["aperture"], sample["distance"], *sample["k"])


def encode_mount(mount, strings: Strings) -> bytes:
    out = struct.pack("<IH", strings.index(mount.name), len(mount.compat))
    return out + b"".join(struct.pack("<I", strings.index(name)) for name in mount.compat)


def encode_camera(camera, strings: Strings) -> bytes:
    out = struct.pack("<IIH", strings.index(camera.maker), strings.index(camera.model), len(camera.variants))
    out += b"".join(struct.pack("<I", strings.index(name)) for name in camera.variants)
    return out + struct.pack("<If", camera.mount, camera.crop)


def encode_lens(lens, strings: Strings) -> bytes:
    out = struct.pack("<IIH", strings.index(lens.maker), strings.index(lens.model), len(lens.names))
    out += b"".join(struct.pack("<I", strings.index(name)) for name in lens.names)
    out += struct.pack("<H", len(lens.mounts)) + b"".join(struct.pack("<I", m) for m in lens.mounts)
    out += struct.pack("<ffB", lens.crop, lens.aspect, lens.kind)
    out += struct.pack("<H", len(lens.distortion)) + b"".join(encode_distortion(s) for s in lens.distortion)
    out += struct.pack("<H", len(lens.tca)) + b"".join(encode_tca(s) for s in lens.tca)
    out += struct.pack("<H", len(lens.vignetting)) + b"".join(encode_vignetting(s) for s in lens.vignetting)
    return out


def encode_database(db) -> bytes:
    """The whole `db.bin`. Records are encoded first so the string table is complete
    before the header that counts it is written."""
    strings = Strings()
    mounts = b"".join(encode_mount(m, strings) for m in db.mounts)
    cameras = b"".join(encode_camera(c, strings) for c in db.cameras)
    lenses = b"".join(encode_lens(l, strings) for l in db.lenses)
    commit = db.commit.encode("ascii")
    date = db.date.encode("ascii")
    if len(commit) > 12 or len(date) != 10:
        raise ValueError(f"header does not fit: commit {db.commit!r} date {db.date!r}")
    header = MAGIC + struct.pack(
        "<HHIIII12s10s", VERSION, 0, len(strings.table), len(db.mounts), len(db.cameras), len(db.lenses), commit, date
    )
    return header + strings.encode() + mounts + cameras + lenses


# --- Markdown ----------------------------------------------------------------------------


def attribution_markdown(db, licence: str) -> str:
    return f"""# Lensfun database attribution

The lens-correction table `db.bin` in this directory is generated from the Lensfun
database by `src/scripts/convert_lensfun_db.py`.

- Source repository: {SOURCE_URL}
- Commit: `{db.commit}`
- Date: {db.date}
- Files: `data/db/*.xml` of that commit

The data is redistributed under the Creative Commons Attribution-Share Alike 3.0
licence (CC BY-SA 3.0), unchanged in substance and converted in representation:
every calibration's coefficients are rescaled into a focal-normalised frame per the
design spec (`{SPEC}`, § "Coordinate system and model conversion"), and the XML is
packed into the binary table described in `src/scripts/convert_lensfun_db_write.py`.

## Conversion rules

With `s = real_focal / h`, where `h = hypot(36, 24) / crop / hypot(aspect, 1) / 2` for
distortion and TCA (Lensfun's Hugin frame, r = 1 at half the short side) and
`h = hypot(36, 24) / crop / 2` for vignetting (r = 1 at the corner); `crop` and `aspect`
are the lens's own calibration values (`aspect` defaults to 3:2):

- `poly3`: `d = 1 − k1`; `scale = d`, even radial `[k1·s²/d³, 0, 0]`, odd `[0, 0]`.
- `poly5`: `scale = 1`, even `[k1·s², k2·s⁴, 0]`, odd `[0, 0]`.
- `ptlens`: `d = 1 − a − b − c`; `scale = d`, even `[b·s²/d³, 0, 0]`, odd `[c·s/d², a·s³/d⁴]`.
- `tca poly3`: per channel `scale = v`, even `[b·s², 0, 0]`, odd `[c·s, 0]` (red then blue,
  relative to green). `tca linear`: `scale = k`, no polynomial terms.
- `vignetting pa`: `k_n' = k_n · s^(2n)` for n = 1..3.
- `real_focal` is the sample's `real-focal` attribute when present, else its `focal`.
- A coefficient a sample omits is 0, and an omitted TCA scale (`vr`, `vb`, `kr`, `kb`) is 1,
  exactly as `liblensfun` zero-fills its calibration structs before parsing.

Names (maker, model, translated model variants, camera variants, mount names and compat
lists) are copied verbatim. Lenses whose `type` is not `rectilinear` are kept with
`kind = 1` and never matched automatically.

## Licence

{licence}"""


def crop_mismatches(db) -> list:
    """Lenses whose crop factor differs from every camera on their mounts (so no bundled
    camera could have produced the calibration) plus lenses with no camera on any mount."""
    crops_by_mount: dict = {}
    for camera in db.cameras:
        crops_by_mount.setdefault(camera.mount, []).append(camera.crop)
    rows = []
    for lens in db.lenses:
        crops = [c for m in lens.mounts for c in crops_by_mount.get(m, [])]
        if not crops:
            rows.append((lens, "no camera on its mounts"))
        elif all(abs(c - lens.crop) >= CROP_TOLERANCE for c in crops):
            nearest = min(crops, key=lambda c: abs(c - lens.crop))
            rows.append((lens, f"nearest camera crop {nearest:g}"))
    return rows


def coverage_markdown(db, size: int) -> str:
    totals = {key: sum(counts[key] for counts in db.per_file.values()) for key in ("distortion", "tca", "vignetting")}
    declared = sum(1 for m in db.mounts if m.declared)
    lines = [
        "# Lensfun bundle coverage",
        "",
        f"Generated by `src/scripts/convert_lensfun_db.py` from {SOURCE_URL} @ `{db.commit}` ({db.date}).",
        "",
        f"Lenses: {len(db.lenses)}",
        f"Cameras: {len(db.cameras)}",
        f"Mounts: {len(db.mounts)}",
        f"db.bin: {size} bytes",
        "",
        f"Rectilinear lenses: {sum(1 for l in db.lenses if l.kind == 0)}",
        f"Declared mounts (with a `<mount>` element): {declared}; "
        f"implicit mounts (referenced by a camera or lens only): {len(db.mounts) - declared}",
        f"Samples: distortion {totals['distortion']}, tca {totals['tca']}, vignetting {totals['vignetting']}",
        "Defaulted attributes (absent in the XML; 0, or 1 for a TCA scale, as in liblensfun): "
        + (", ".join(f"{attr} {n}" for attr, n in sorted(db.defaulted.items())) or "none"),
        "",
        "## Per file",
        "",
        "| File | Mounts | Cameras | Lenses | Distortion | TCA | Vignetting |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for file, c in db.per_file.items():
        lines.append(
            f"| {file} | {c['mounts']} | {c['cameras']} | {c['lenses']} | {c['distortion']} | {c['tca']} | {c['vignetting']} |"
        )
    mismatches = crop_mismatches(db)
    lines += [
        "",
        f"## Lenses whose crop factor differs from every camera on their mount ({len(mismatches)})",
        "",
        f"Crop factors are compared with a tolerance of {CROP_TOLERANCE}.",
        "",
    ]
    lines += [f"- {l.file} — {l.maker} {l.model} (crop {l.crop:g}): {why}" for l, why in mismatches]
    lines += ["", f"## Skipped ({len(db.skipped)})", ""]
    lines += [f"- {s.file} — {s.entry} — {s.reason}" for s in db.skipped]
    return "\n".join(lines) + "\n"


def write_outputs(db, licence: str, out_dir: Path) -> int:
    """Write db.bin, ATTRIBUTION.md and COVERAGE.md; returns the size of db.bin in bytes."""
    out_dir.mkdir(parents=True, exist_ok=True)
    blob = encode_database(db)
    (out_dir / "db.bin").write_bytes(blob)
    (out_dir / "ATTRIBUTION.md").write_text(attribution_markdown(db, licence), encoding="utf-8")
    (out_dir / "COVERAGE.md").write_text(coverage_markdown(db, len(blob)), encoding="utf-8")
    return len(blob)
