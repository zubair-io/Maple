#!/usr/bin/env python3
"""Fail-closed Auto vs embedded-JPEG qualification; preserves per-image evidence.

The ACR reference images and ACR budgets are never read. The established
five-band/channel bias metric and default 0.05 budget are retained.
Full-frame spatial, absolute-error, perceptual and clipping checks also gate.
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import auto_profile_alignment as alignment
import auto_profile_diff as diff
import auto_profile_quality as quality
import numpy as np
from PIL import Image

EXTENSIONS = {
    ".dng",
    ".raw",
    ".cr2",
    ".cr3",
    ".raf",
    ".arw",
    ".nef",
    ".fff",
    ".rw2",
    ".orf",
    ".pef",
    ".srw",
}


def sha(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fixtures(raw_dir, manifest, name_filter):
    if manifest:
        data = json.loads(Path(manifest).read_text())
        selected = [
            (c["name"].split("/")[0], Path(c["raw"]))
            for c in data["cases"]
            if c["name"].endswith("/baseline")
        ]
        selected = [
            (name, raw if raw.is_absolute() else Path(manifest).resolve().parent / raw)
            for name, raw in selected
        ]
    else:
        selected = [
            (p.stem, p)
            for p in Path(raw_dir).glob("test_*")
            if p.suffix.lower() in EXTENSIONS and p.is_file()
        ]
    selected = sorted(
        (name, raw.resolve())
        for name, raw in selected
        if not name_filter or name_filter in name or name_filter in raw.name
    )
    if not selected:
        raise ValueError("no matching RAW fixtures; zero comparisons cannot pass")
    if len({name for name, _ in selected}) != len(selected):
        raise ValueError("duplicate fixture names")
    return selected


def compare(candidate, reference, budget):
    ref = diff.load(reference)
    cand = diff.match_shape(diff.load(candidate), ref)
    spatial = quality.compare(candidate, reference)
    warp = np.asarray(spatial["alignment"]["candidate_to_reference_normalized"])
    unaligned_native = quality.native_absolute(cand, ref, budget)
    h, w = ref.shape[:2]
    y, x = round(h * 0.1), round(w * 0.1)
    unaligned_bands = diff.per_band_bias(
        cand[y : h - y, x : w - x], ref[y : h - y, x : w - x]
    )
    ref, valid = alignment.resample_reference(ref, warp)
    bands = diff.per_band_bias(
        cand[y : h - y, x : w - x],
        ref[y : h - y, x : w - x],
        valid[y : h - y, x : w - x],
    )
    if not bands or not all(
        math.isfinite(v[ch]) for v in bands.values() for ch in "RGB"
    ):
        raise ValueError("no measurable luma bands or nonfinite bias")
    breaches = [
        {"band": band, "channel": ch, "bias": v[ch], "limit": budget}
        for band, v in bands.items()
        for ch in "RGB"
        if abs(v[ch]) > budget
    ]
    native = quality.native_absolute(cand, ref, budget, valid)
    return {
        "quality": spatial,
        "unaligned": {"native_absolute": unaligned_native, "bands": unaligned_bands},
        "native_absolute": native,
        "bands": bands,
        "breaches": breaches,
        "status": "failed"
        if breaches or native["breaches"] or spatial["breaches"]
        else "passed",
    }


def validate_previewless(cli, raw, folder, env):
    images = []
    for profile in ["auto", "neutral"]:
        target = folder / f"fallback-{profile}.png"
        with (folder / f"fallback-{profile}.log").open("w") as log:
            result = subprocess.run(
                [
                    str(cli),
                    "render",
                    str(raw),
                    "--out",
                    str(target),
                    "--profile",
                    profile,
                ],
                check=False,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        if result.returncode:
            raise RuntimeError(
                f"previewless {profile} render exited {result.returncode}"
            )
        images.append(target)
    with Image.open(images[0]) as first, Image.open(images[1]) as second:
        if first.mode != "RGB" or second.mode != "RGB" or first.size != second.size:
            raise ValueError("previewless Auto/Neutral output geometry or mode differs")
        for y in range(0, first.height, 64):
            box = (0, y, first.width, min(first.height, y + 64))
            if not np.array_equal(
                np.asarray(first.crop(box)), np.asarray(second.crop(box))
            ):
                raise ValueError("previewless Auto does not equal Neutral")
    return {
        "status": "passed",
        "metric": "exact decoded RGB equality: Auto versus Neutral",
        "auto_sha256": sha(images[0]),
        "neutral_sha256": sha(images[1]),
    }


def qualify(cli, selected, out, budget):
    identity = {
        "target": "camera-embedded-jpeg",
        "profile": "auto",
        "metric": "legacy signed band bias AND full-frame non-cancelling image-quality checks",
        "quality_policy": quality.POLICY,
        "quality_implementation_sha256": sha(quality.__file__),
        "budget": budget,
        "binary": str(cli),
        "binary_sha256": sha(cli),
        "geometry": "default lens-corrected render; structural affine reference coordinates; full overlap plus inner 80% bias",
        "alignment_policy": alignment.POLICY,
        "alignment_implementation_sha256": sha(alignment.__file__),
        "registration_implementation_sha256": sha(alignment.registration.__file__),
        "reference_decode": "extract-preview: display-oriented, Adobe RGB converted to sRGB",
        "runner_sha256": sha(__file__),
        "comparator_sha256": sha(diff.__file__),
        "selected": len(selected),
        "cases": [],
        "complete": False,
    }
    summary = out / "summary.json"

    def save():
        summary.write_text(json.dumps(identity, indent=2) + "\n")

    save()
    env = {k: v for k, v in os.environ.items() if not k.startswith("MAPLE_")}
    for name, raw in selected:
        row = {"fixture": name, "raw": str(raw)}
        folder = out / name
        folder.mkdir()
        try:
            before = sha(raw)
            row["raw_sha256"] = before
            preview = folder / "embedded.png"
            auto = folder / "auto.png"
            # Extract first: a preview-less RAW cannot test JPEG matching.
            for action, args in [
                ("preview", ["extract-preview", str(raw), "--out", str(preview)]),
                (
                    "render",
                    ["render", str(raw), "--out", str(auto), "--profile", "auto"],
                ),
            ]:
                with (folder / f"{action}.log").open("w") as log:
                    result = subprocess.run(
                        [str(cli), *args],
                        check=False,
                        env=env,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                    )
                if action == "preview" and result.returncode == 3:
                    row.update(
                        status="no-preview",
                        reason="explicit CLI no-preview sentinel; not a JPEG match pass",
                        fallback=validate_previewless(cli, raw, folder, env),
                    )
                    break
                if result.returncode:
                    raise RuntimeError(
                        f"{action} exited {result.returncode}; see {action}.log"
                    )
            else:
                row.update(compare(auto, preview, budget))
                row.update(candidate_sha256=sha(auto), reference_sha256=sha(preview))
            if sha(raw) != before:
                raise RuntimeError("RAW changed during qualification")
        except (OSError, ValueError, RuntimeError, SystemExit) as error:
            row.update(status="error", reason=str(error))
        identity["cases"].append(row)
        save()
        print(f"{name}: {row['status']}", flush=True)
    counts = {
        status: sum(c["status"] == status for c in identity["cases"])
        for status in ["passed", "failed", "no-preview", "error"]
    }
    identity.update(
        counts=counts,
        previewless_fallback_checks=sum("fallback" in row for row in identity["cases"]),
        complete=True,
        binary_unchanged=sha(cli) == identity["binary_sha256"],
    )
    compared = counts["passed"] + counts["failed"]
    identity["status"] = (
        "passed"
        if compared > 0
        and not counts["failed"]
        and not counts["error"]
        and identity["binary_unchanged"]
        else "failed"
    )
    save()
    print(
        json.dumps(
            {
                "status": identity["status"],
                "compared": compared,
                **counts,
                "evidence": str(out),
            }
        )
    )
    return 0 if identity["status"] == "passed" else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cli", required=True, type=Path)
    ap.add_argument("--raw-dir", type=Path)
    ap.add_argument(
        "--manifest", type=Path, help="select baseline RAW paths; never read ACR PNGs"
    )
    ap.add_argument("--output", type=Path)
    ap.add_argument("--filter", default="")
    ap.add_argument("--budget", type=float, default=0.05)
    args = ap.parse_args()
    if not math.isfinite(args.budget) or args.budget < 0:
        ap.error("budget must be finite and nonnegative")
    if not args.raw_dir and not args.manifest:
        ap.error("--raw-dir or --manifest is required")
    try:
        selected = fixtures(args.raw_dir, args.manifest, args.filter)
        out = (
            args.output.resolve()
            if args.output
            else Path(tempfile.mkdtemp(prefix="maple-auto-jpeg-"))
        )
        if args.output:
            out.mkdir(parents=True, exist_ok=False)
        return qualify(args.cli.resolve(), selected, out, args.budget)
    except (OSError, ValueError) as error:
        ap.error(str(error))


if __name__ == "__main__":
    sys.exit(main())
