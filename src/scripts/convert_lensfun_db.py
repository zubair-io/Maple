#!/usr/bin/env python3
"""Convert a pinned Lensfun checkout into raw-core's bundled lens-correction table.

Usage: convert_lensfun_db.py <lensfun-checkout> <out-dir>

Reads every `data/db/*.xml` of the checkout and writes into <out-dir>:

- `db.bin`         the little-endian binary table read by raw-core (`lens_profile/lensfun`)
- `ATTRIBUTION.md` source commit, date, conversion rules and the CC BY-SA 3.0 text
- `COVERAGE.md`    counts per file, totals, and every entry the converter skipped

Every calibration sample is rescaled from Lensfun's Hugin / corner-normalised frame into
raw-core's focal-normalised frame (radius = distance from the centre divided by the focal
length), so the reader never needs the crop factor or aspect ratio of the calibration
camera. See docs/superpowers/specs/2026-09-12-lensfun-bundled-lens-corrections-design.md
§ "Coordinate system and model conversion".

The canonical-name rule (`canonical`, `canonical_camera`) is mirrored byte-for-byte by the
Rust matcher in `lens_profile/lensfun/names.rs`; both sides are tested with the same table.
"""

from __future__ import annotations

import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

DIAG = math.hypot(36.0, 24.0)
DEFAULT_ASPECT = 1.5
KIND_RECTILINEAR = 0
KIND_OTHER = 1


# --- Canonical names -------------------------------------------------------------------


def canonical(maker: str, name: str) -> str:
    """Normalise a lens or camera name so EXIF and Lensfun spellings meet.

    Lower-cases, strips a leading maker (the whole maker, else its first token — so
    "NIKON CORPORATION" / "NIKON D850" and "Nikon" / "Nikon D850" both become "d850"),
    treats "f/" and "f" as the same aperture prefix, and drops every whitespace character.
    """
    lowered = name.lower()
    maker_lower = maker.lower()
    maker_tokens = maker_lower.split()
    first_token = maker_tokens[0] if maker_tokens else ""
    stripped = (
        lowered[len(maker_lower) + 1 :]
        if maker_lower and lowered.startswith(maker_lower + " ")
        else lowered[len(first_token) + 1 :]
        if first_token and lowered.startswith(first_token + " ")
        else lowered
    )
    return "".join(stripped.replace("f/", "f").split())


def canonical_camera(maker: str, model: str) -> str:
    """Camera rule: the lens rule plus stripping a leading token equal to the maker's
    first token, which `canonical` already applies. Kept as its own entry point so the
    matcher names the camera rule explicitly."""
    return canonical(maker, model)


# --- Coordinate conversion --------------------------------------------------------------


def hugin_scale_mm(crop: float, aspect: float) -> float:
    """Distortion / TCA: Lensfun's r = 1 at half the short side of the calibration sensor."""
    return DIAG / crop / math.hypot(aspect, 1.0) / 2.0


def vignette_scale_mm(crop: float) -> float:
    """Vignetting: Lensfun's r = 1 at the corner of the calibration sensor."""
    return DIAG / crop / 2.0


def convert_distortion(model: str, terms: dict, real_focal: float, crop: float, aspect: float) -> dict:
    s = real_focal / hugin_scale_mm(crop, aspect)
    if model == "poly3":
        k1 = terms["k1"]
        d = 1.0 - k1
        return dict(scale=1.0, even=[k1 * s**2 / d**3, 0.0, 0.0], odd=[0.0, 0.0])
    if model == "poly5":
        return dict(scale=1.0, even=[terms["k1"] * s**2, terms["k2"] * s**4, 0.0], odd=[0.0, 0.0])
    if model == "ptlens":
        a, b, c = terms["a"], terms["b"], terms["c"]
        d = 1.0 - a - b - c
        return dict(scale=1.0, even=[b * s**2 / d**3, 0.0, 0.0], odd=[c * s / d**2, a * s**3 / d**4])
    raise ValueError(model)


def convert_tca(model: str, terms: dict, real_focal: float, crop: float, aspect: float) -> list:
    s = real_focal / hugin_scale_mm(crop, aspect)
    if model == "linear":
        return [
            dict(scale=terms["kr"], even=[0.0, 0.0, 0.0], odd=[0.0, 0.0]),
            dict(scale=terms["kb"], even=[0.0, 0.0, 0.0], odd=[0.0, 0.0]),
        ]
    if model == "poly3":
        return [
            dict(scale=terms["vr"], even=[terms["br"] * s**2, 0.0, 0.0], odd=[terms["cr"] * s, 0.0]),
            dict(scale=terms["vb"], even=[terms["bb"] * s**2, 0.0, 0.0], odd=[terms["cb"] * s, 0.0]),
        ]
    raise ValueError(model)


def convert_vignetting(model: str, terms: dict, real_focal: float, crop: float) -> list:
    s = real_focal / vignette_scale_mm(crop)
    if model != "pa":
        raise ValueError(model)
    return [terms["k1"] * s**2, terms["k2"] * s**4, terms["k3"] * s**6]


# --- Records ---------------------------------------------------------------------------


@dataclass
class Mount:
    name: str
    compat: list = field(default_factory=list)
    declared: bool = False


@dataclass
class Camera:
    maker: str
    model: str
    variants: list
    mount: int
    crop: float
    file: str


@dataclass
class Lens:
    maker: str
    model: str
    names: list
    mounts: list
    crop: float
    aspect: float
    kind: int
    distortion: list = field(default_factory=list)
    tca: list = field(default_factory=list)
    vignetting: list = field(default_factory=list)
    file: str = ""


@dataclass
class Skipped:
    file: str
    entry: str
    reason: str


@dataclass
class Database:
    commit: str
    date: str
    mounts: list = field(default_factory=list)
    cameras: list = field(default_factory=list)
    lenses: list = field(default_factory=list)
    skipped: list = field(default_factory=list)
    per_file: dict = field(default_factory=dict)
    defaulted: Counter = field(default_factory=Counter)

    def mount_index(self, name: str) -> int:
        """Index of `name` in the mount table, creating an undeclared (compat-less) entry
        on first reference. Fixed-lens compacts reference mounts no file ever declares."""
        for i, mount in enumerate(self.mounts):
            if mount.name == name:
                return i
        self.mounts.append(Mount(name))
        return len(self.mounts) - 1


# --- XML parsing ------------------------------------------------------------------------

DISTORTION_TERMS = {"poly3": ["k1"], "poly5": ["k1", "k2"], "ptlens": ["a", "b", "c"]}
TCA_TERMS = {"linear": ["kr", "kb"], "poly3": ["vr", "vb", "br", "bb", "cr", "cb"]}
VIGNETTING_TERMS = {"pa": ["k1", "k2", "k3"]}
# liblensfun zero-fills every calibration struct before reading its attributes and starts
# the TCA scale terms at 1.0 (database.cpp), so an absent coefficient is a real value —
# many `tca poly3` samples carry only `vr`/`vb` — not a broken sample. Only the sample's
# identity (focal, aperture, distance) has no default.
REQUIRED_ATTRIBUTES = {"focal", "aperture", "distance"}
IDENTITY_SCALE_TERMS = {"vr", "vb", "kr", "kb"}


class SampleError(ValueError):
    pass


def text(element: ET.Element | None) -> str:
    return (element.text or "").strip() if element is not None else ""


def parse_aspect(value: str) -> float:
    if not value:
        return DEFAULT_ASPECT
    if ":" in value:
        w, h = value.split(":", 1)
        return float(w) / float(h)
    return float(value)


def base_and_variants(parent: ET.Element, tag: str) -> tuple[str, list]:
    """The untranslated `<tag>` text and every `<tag lang="…">` translation."""
    elements = parent.findall(tag)
    base = next((text(e) for e in elements if e.get("lang") is None), text(elements[0]) if elements else "")
    variants = [text(e) for e in elements if e.get("lang") is not None and text(e) and text(e) != base]
    return base, variants


def number(sample: ET.Element, attr: str, defaulted: Counter) -> float:
    raw = sample.get(attr)
    if raw is None:
        if attr in REQUIRED_ATTRIBUTES:
            raise SampleError(f"missing attribute {attr}")
        defaulted[attr] += 1
        return 1.0 if attr in IDENTITY_SCALE_TERMS else 0.0
    try:
        return float(raw)
    except ValueError as err:
        raise SampleError(f"unparsable {attr}={raw!r}") from err


def terms_of(sample: ET.Element, names: list, defaulted: Counter) -> dict:
    return {name: number(sample, name, defaulted) for name in names}


def focal_pair(sample: ET.Element, defaulted: Counter) -> tuple[float, float]:
    focal = number(sample, "focal", defaulted)
    if focal <= 0.0:
        raise SampleError(f"non-positive focal {focal}")
    real_focal = number(sample, "real-focal", defaulted) if sample.get("real-focal") is not None else focal
    if real_focal <= 0.0:
        raise SampleError(f"non-positive real-focal {real_focal}")
    return focal, real_focal


def parse_distortion(sample: ET.Element, lens: Lens, defaulted: Counter) -> dict:
    model = sample.get("model", "")
    if model not in DISTORTION_TERMS:
        raise SampleError(f"unknown distortion model {model!r}")
    focal, real_focal = focal_pair(sample, defaulted)
    terms = terms_of(sample, DISTORTION_TERMS[model], defaulted)
    converted = convert_distortion(model, terms, real_focal, lens.crop, lens.aspect)
    return dict(focal=focal, real_focal=real_focal, **converted)


def parse_tca(sample: ET.Element, lens: Lens, defaulted: Counter) -> dict:
    model = sample.get("model", "")
    if model not in TCA_TERMS:
        raise SampleError(f"unknown tca model {model!r}")
    focal, real_focal = focal_pair(sample, defaulted)
    terms = terms_of(sample, TCA_TERMS[model], defaulted)
    red, blue = convert_tca(model, terms, real_focal, lens.crop, lens.aspect)
    return dict(focal=focal, real_focal=real_focal, red=red, blue=blue)


def parse_vignetting(sample: ET.Element, lens: Lens, defaulted: Counter) -> dict:
    model = sample.get("model", "")
    if model not in VIGNETTING_TERMS:
        raise SampleError(f"unknown vignetting model {model!r}")
    focal, real_focal = focal_pair(sample, defaulted)
    aperture = number(sample, "aperture", defaulted)
    distance = number(sample, "distance", defaulted)
    if aperture <= 0.0 or distance <= 0.0:
        raise SampleError(f"non-positive aperture/distance {aperture}/{distance}")
    k = convert_vignetting(model, terms_of(sample, VIGNETTING_TERMS[model], defaulted), real_focal, lens.crop)
    return dict(focal=focal, aperture=aperture, distance=distance, k=k)


SAMPLE_PARSERS = {"distortion": parse_distortion, "tca": parse_tca, "vignetting": parse_vignetting}


def parse_calibration(lens: Lens, element: ET.Element, db: Database, label: str) -> None:
    for calibration in element.findall("calibration"):
        for sample in calibration:
            parser = SAMPLE_PARSERS.get(sample.tag)
            if parser is None:
                db.skipped.append(Skipped(lens.file, label, f"unknown calibration element <{sample.tag}>"))
                continue
            try:
                getattr(lens, sample.tag).append(parser(sample, lens, db.defaulted))
            except SampleError as err:
                db.skipped.append(Skipped(lens.file, label, f"<{sample.tag} focal={sample.get('focal')!r}>: {err}"))


def parse_lens(element: ET.Element, db: Database, file: str) -> Lens | None:
    maker, _ = base_and_variants(element, "maker")
    model, names = base_and_variants(element, "model")
    label = f"lens {maker} {model}"
    try:
        crop = float(text(element.find("cropfactor")))
        aspect = parse_aspect(text(element.find("aspect-ratio")))
    except ValueError as err:
        db.skipped.append(Skipped(file, label, f"unparsable cropfactor/aspect-ratio: {err}"))
        return None
    if crop <= 0.0:
        db.skipped.append(Skipped(file, label, f"non-positive cropfactor {crop}"))
        return None
    mounts = [db.mount_index(text(m)) for m in element.findall("mount") if text(m)]
    if not mounts:
        db.skipped.append(Skipped(file, label, "no mount"))
        return None
    lens_type = text(element.find("type"))
    kind = KIND_RECTILINEAR if lens_type in ("", "rectilinear") else KIND_OTHER
    lens = Lens(maker, model, names, mounts, crop, aspect, kind, file=file)
    parse_calibration(lens, element, db, label)
    if not (lens.distortion or lens.tca or lens.vignetting):
        # An alternate calibration set for the same lens is a separate <lens> element with
        # its own crop factor and is kept as its own record; a record with nothing to
        # apply is not.
        detail = "no <calibration> element" if element.find("calibration") is None else "no usable sample"
        db.skipped.append(Skipped(file, label, f"No calibration: {detail}"))
        return None
    if kind == KIND_OTHER:
        db.skipped.append(
            Skipped(file, label, f"type {lens_type!r} is not rectilinear (kept with kind=1, excluded from matching)")
        )
    return lens


def parse_camera(element: ET.Element, db: Database, file: str) -> Camera | None:
    maker, _ = base_and_variants(element, "maker")
    model, variants = base_and_variants(element, "model")
    label = f"camera {maker} {model}"
    variants = variants + [text(v) for v in element.findall("variant") if text(v)]
    mount_name = text(element.find("mount"))
    if not mount_name:
        db.skipped.append(Skipped(file, label, "no mount"))
        return None
    try:
        crop = float(text(element.find("cropfactor")))
    except ValueError as err:
        db.skipped.append(Skipped(file, label, f"unparsable cropfactor: {err}"))
        return None
    if crop <= 0.0:
        db.skipped.append(Skipped(file, label, f"non-positive cropfactor {crop}"))
        return None
    return Camera(maker, model, variants, db.mount_index(mount_name), crop, file)


def parse_mount(element: ET.Element, db: Database) -> None:
    name, _ = base_and_variants(element, "name")
    if not name:
        return
    mount = db.mounts[db.mount_index(name)]
    mount.declared = True
    for compat in (text(c) for c in element.findall("compat")):
        if compat and compat not in mount.compat:
            mount.compat.append(compat)


def parse_file(path: Path, db: Database) -> None:
    root = ET.parse(path).getroot()
    file = path.name
    counts = dict(mounts=0, cameras=0, lenses=0, distortion=0, tca=0, vignetting=0)
    for element in root:
        if element.tag == "mount":
            parse_mount(element, db)
            counts["mounts"] += 1
        elif element.tag == "camera":
            camera = parse_camera(element, db, file)
            if camera is not None:
                db.cameras.append(camera)
                counts["cameras"] += 1
        elif element.tag == "lens":
            lens = parse_lens(element, db, file)
            if lens is not None:
                db.lenses.append(lens)
                counts["lenses"] += 1
                counts["distortion"] += len(lens.distortion)
                counts["tca"] += len(lens.tca)
                counts["vignetting"] += len(lens.vignetting)
    db.per_file[file] = counts


def checkout_version(checkout: Path) -> tuple[str, str]:
    """Short commit and ISO committer date of the checkout's HEAD."""
    run = lambda *args: subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()
    return run("rev-parse", "--short=7", "HEAD"), run("log", "-1", "--format=%cs", "HEAD")


def load(checkout: Path) -> Database:
    commit, date = checkout_version(checkout)
    db = Database(commit, date)
    for path in sorted((checkout / "data" / "db").glob("*.xml")):
        parse_file(path, db)
    return db


def main(argv: list) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    from convert_lensfun_db_write import write_outputs

    checkout, out_dir = Path(argv[1]), Path(argv[2])
    db = load(checkout)
    licence = (checkout / "docs" / "cc-by-sa-3.0.txt").read_text(encoding="utf-8")
    size = write_outputs(db, licence, out_dir)
    print(
        f"Lenses: {len(db.lenses)}  Cameras: {len(db.cameras)}  Mounts: {len(db.mounts)}  "
        f"db.bin: {size} bytes  skipped: {len(db.skipped)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
