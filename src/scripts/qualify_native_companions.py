#!/usr/bin/env python3
"""Qualify native Adobe companions while preserving every original reference.

A capture must reproduce the original down PNG's RGB pixels and satisfy its
complete authored Camera Raw contract. RAW and canonical XMP identities must also match. Only then
may a separate output manifest opt that case into native-pair-lanczos-v1.
No original files or numerical budgets are written.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path

from compare_images_metadata import (
    camera_raw_settings,
    reference_crs,
    verify_authoring_settings,
)
from PIL import Image, ImageChops


def _read_manifest(path: Path) -> dict:
    data = json.loads(path.read_text())
    if not data.get("cases"):
        raise ValueError("empty reference manifest")
    data = copy.deepcopy(data)
    seen = set()
    for case in data["cases"]:
        if case["name"] in seen:
            raise ValueError(f"duplicate case: {case['name']}")
        seen.add(case["name"])
        for key in ("raw", "xmp", "acr_xmp"):
            if key in case:
                value = Path(case[key])
                case[key] = str((path.parent / value).resolve())
        outputs = case.get("outputs", [])
        resolutions = [o["resolution"] for o in outputs]
        if len(resolutions) != len(set(resolutions)):
            raise ValueError(f"duplicate resolution: {case['name']}")
        for output in outputs:
            output["png"] = str((path.parent / output["png"]).resolve())
    return data


def qualify(base_path: Path, capture_path: Path) -> tuple[dict, dict]:
    # Use the same complete Adobe verifier as the canonical comparator.
    sys.path.insert(0, str(Path(__file__).resolve().parent / "acr-reference"))
    from verify_settings import verify_png
    from write_xmp import reference_settings

    base = _read_manifest(base_path)
    captures = _read_manifest(capture_path)
    indexed = {case["name"]: case for case in base["cases"]}
    hashes = {}

    def sha(path: str | Path) -> str:
        path = str(path)
        if path not in hashes:
            with open(path, "rb") as stream:
                hashes[path] = hashlib.file_digest(stream, "sha256").hexdigest()
        return hashes[path]

    qualified = []
    for capture in captures["cases"]:
        name = capture["name"]
        if name not in indexed:
            raise ValueError(f"unknown captured case: {name}")
        original = indexed[name]
        if original.get("reference_protocol") is not None:
            raise ValueError(f"case already declares a protocol: {name}")
        outputs = {o["resolution"]: o for o in original["outputs"]}
        fresh = {o["resolution"]: o for o in capture["outputs"]}
        if "full" in outputs or "down" not in outputs:
            raise ValueError(f"case must have an original down-only reference: {name}")
        if set(fresh) != {"full", "down"}:
            raise ValueError(f"capture must supply exactly full and down: {name}")
        for key in ("raw", "xmp"):
            if sha(original[key]) != sha(capture[key]):
                raise ValueError(f"captured {key} identity differs: {name}")
        sidecar = capture.get("acr_xmp")
        if not sidecar:
            raise ValueError(f"capture requires explicit Adobe sidecar: {name}")
        packet = Path(sidecar).read_bytes()
        authored = camera_raw_settings(packet)
        expected = reference_settings(packet)
        old_png = outputs["down"]["png"]
        down_png = fresh["down"]["png"]
        full_png = fresh["full"]["png"]
        with (
            Image.open(old_png) as old,
            Image.open(down_png) as down,
            Image.open(full_png) as full,
        ):
            # Reject DTDs through the complete parser before any subset parse.
            old_settings = reference_crs(old)
            settings = reference_crs(down)
            native_settings = reference_crs(full)
            for png in (old_png, down_png, full_png):
                verify_png(Path(png), expected)
            if (
                old.size != down.size
                or ImageChops.difference(
                    old.convert("RGB"), down.convert("RGB")
                ).getbbox()
                is not None
            ):
                raise ValueError(
                    f"captured down RGB pixels differ from original: {name}"
                )
            if settings != native_settings:
                raise ValueError(f"native/down Camera Raw settings differ: {name}")
            verify_authoring_settings(authored, old_settings)
            verify_authoring_settings(authored, settings)
            width, height = full.size
            dw, dh = old.size
            if (
                dw > width
                or dh > height
                or abs(dw * height - dh * width) > max(width, height)
            ):
                raise ValueError(f"native/down geometry differs: {name}")
            native_size, down_size = full.size, old.size
        # Keep original files intact. The separately declared down capture has
        # identical RGB pixels and the same export metadata as its native pair.
        original["outputs"] = [fresh["down"], fresh["full"]]
        original["acr_xmp"] = sidecar
        original["reference_protocol"] = "native-pair-lanczos-v1"
        qualified.append(
            {
                "case": name,
                "raw_sha256": sha(original["raw"]),
                "canonical_xmp_sha256": sha(original["xmp"]),
                "original_down": old_png,
                "original_down_sha256": sha(old_png),
                "qualified_down": down_png,
                "captured_down_sha256": sha(down_png),
                "capture_added_metadata_changes": {
                    k: {
                        "before": str(old_settings.get(k)),
                        "after": str(settings.get(k)),
                    }
                    for k in old_settings.keys() | settings.keys()
                    if old_settings.get(k) != settings.get(k)
                },
                "native": full_png,
                "native_sha256": sha(full_png),
                "authoring_sidecar_sha256": sha(sidecar),
                "native_dimensions": native_size,
                "down_dimensions": down_size,
                "down_rgb_pixels_identical": True,
            }
        )
    return base, {
        "scope": "Qualified native companions; original references and budgets unchanged.",
        "base_manifest_sha256": sha(base_path),
        "capture_manifest_sha256": sha(capture_path),
        "qualifier_sha256": sha(Path(__file__)),
        "qualified": len(qualified),
        "cases": qualified,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_manifest", type=Path)
    parser.add_argument("capture_manifest", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    manifest, report = qualify(args.base_manifest, args.capture_manifest)
    # Refuse to overwrite any consumed asset or either source manifest.
    protected = {args.base_manifest.resolve(), args.capture_manifest.resolve()}
    for path in (args.base_manifest, args.capture_manifest):
        for case in _read_manifest(path)["cases"]:
            protected.update(
                Path(case[k]) for k in ("raw", "xmp", "acr_xmp") if k in case
            )
            protected.update(Path(o["png"]) for o in case["outputs"])
    if args.output.resolve() in protected or args.report.resolve() in protected:
        raise ValueError(
            "output/report must not overwrite an original or captured input"
        )
    if args.output.resolve() == args.report.resolve():
        raise ValueError("output manifest and report must be different files")
    for destination in (args.output, args.report):
        if destination.exists():
            raise FileExistsError(f"use a new output path: {destination}")
        if not destination.parent.is_dir():
            raise FileNotFoundError(f"output directory missing: {destination.parent}")
    with args.output.open("x") as stream:
        stream.write(json.dumps(manifest, indent=2) + "\n")
    with args.report.open("x") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    print(
        f"Qualified {report['qualified']} native companions; original inputs unchanged"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
