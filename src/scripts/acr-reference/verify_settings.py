#!/usr/bin/env python3
"""Verify saved ACR PNG tone/lens state against authored sidecars (#3633)."""

import argparse
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

from PIL import Image
from write_xmp import REFERENCE_DEFAULTS, reference_settings


def equivalent(key, actual, expected) -> bool:
    if isinstance(expected, tuple):
        if not isinstance(actual, tuple) or len(actual) != len(expected):
            return False
        try:
            return all(
                tuple(Decimal(x.strip()) for x in a.split(","))
                == tuple(Decimal(x.strip()) for x in e.split(","))
                for a, e in zip(actual, expected)
            )
        except InvalidOperation:
            return False
    if key in ("WhiteBalance", "ToneCurveName2012"):
        return actual.casefold() == expected.casefold()
    boolean = {"true": "1", "false": "0", "on": "1", "off": "0"}
    try:
        return Decimal(boolean.get(actual.lower(), actual)) == Decimal(
            boolean.get(expected.lower(), expected)
        )
    except (InvalidOperation, AttributeError):
        return False


def verify_png(path: Path, expected: dict) -> None:
    if set(expected) != set(REFERENCE_DEFAULTS):
        raise ValueError(
            "reference XMP must explicitly author all neutral tone/lens controls"
        )
    with Image.open(path) as image:
        metadata = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
    if not metadata:
        raise ValueError(f"saved PNG has no effective ACR XMP: {path}")
    actual = reference_settings(metadata)
    # ACR omits these dormant subcontrols when their parent amount is zero,
    # even when explicitly authored (verified on real nr/sharpen endpoint PNGs).
    dormant_parent = {
        "SharpenRadius": "Sharpness",
        "SharpenDetail": "Sharpness",
        "SharpenEdgeMasking": "Sharpness",
        "ColorNoiseReductionDetail": "ColorNoiseReduction",
        "ColorNoiseReductionSmoothness": "ColorNoiseReduction",
    }
    for key in REFERENCE_DEFAULTS:
        parent = dormant_parent.get(key)
        if key not in actual and parent and equivalent(parent, actual.get(parent), "0"):
            continue
        if key not in actual or not equivalent(key, actual[key], expected[key]):
            raise ValueError(
                f"{path}: effective {key}={actual.get(key)!r}, expected {expected[key]}"
            )


def verify_manifest(path: Path) -> int:
    manifest = json.loads(path.read_text())
    if not manifest.get("cases"):
        raise ValueError("empty reference manifest")
    count = 0
    for case in manifest["cases"]:
        expected = reference_settings(Path(case["acr_xmp"]).read_bytes())
        if not case.get("outputs"):
            raise ValueError(f"no reference outputs for {case['name']}")
        for output in case["outputs"]:
            verify_png(Path(output["png"]), expected)
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        count = verify_manifest(args.manifest)
    except (OSError, ValueError, KeyError) as error:
        print(f"ACR settings audit FAILED: {error}", file=sys.stderr)
        return 1
    print(
        f"ACR settings audit passed: {count} saved PNGs match explicit tone/lens settings"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
