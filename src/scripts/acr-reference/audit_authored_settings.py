#!/usr/bin/env python3
"""Audit authored controls against saved Adobe PNGs without changing inputs.

This historical-corpus audit checks only controls explicitly present in the
paired canonical XMP. It does not invent defaults or certify omitted controls.
Use verify_settings.py for complete, explicitly authored reference sidecars.
"""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image
from verify_settings import equivalent
from write_xmp import reference_settings

DORMANT_PARENT = {
    "SharpenRadius": "Sharpness",
    "SharpenDetail": "Sharpness",
    "SharpenEdgeMasking": "Sharpness",
    "ColorNoiseReductionDetail": "ColorNoiseReduction",
    "ColorNoiseReductionSmoothness": "ColorNoiseReduction",
    "LuminanceNoiseReductionDetail": "LuminanceSmoothing",
    "LuminanceNoiseReductionContrast": "LuminanceSmoothing",
}


def audit_png(path: Path, authored: dict) -> list[dict]:
    with Image.open(path) as image:
        metadata = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
    if not metadata:
        raise ValueError("saved PNG has no effective Adobe XMP")
    actual = reference_settings(metadata)
    mismatches = []
    for key, expected in sorted(authored.items()):
        value = actual.get(key)
        parent = DORMANT_PARENT.get(key)
        if value is None and parent and equivalent(parent, actual.get(parent), "0"):
            continue
        if value is None or not equivalent(key, value, expected):
            mismatches.append(
                {"control": key, "authored": expected, "effective": value}
            )
    return mismatches


def audit_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text())
    if not manifest.get("cases"):
        raise ValueError("empty reference manifest")
    rows = []

    def resolve(value: str) -> Path:
        candidate = Path(value)
        return candidate if candidate.is_absolute() else path.parent / candidate

    for case in manifest["cases"]:
        outputs = case.get("outputs") or [{}]
        try:
            authored = reference_settings(resolve(case["xmp"]).read_bytes())
            if not authored:
                raise ValueError("canonical sidecar has no auditable authored controls")
        except (OSError, ValueError, KeyError, ET.ParseError) as error:
            rows.extend(
                {
                    "case": case["name"],
                    "resolution": output.get("resolution"),
                    "status": "error",
                    "error": str(error),
                }
                for output in outputs
            )
            continue
        for output in outputs:
            row = {"case": case["name"], "resolution": output.get("resolution")}
            try:
                png = resolve(output["png"])
                row["png"] = str(png)
                row["mismatches"] = audit_png(png, authored)
                row["status"] = "mismatch" if row["mismatches"] else "matched"
            except (OSError, ValueError, KeyError, ET.ParseError) as error:
                row.update(status="error", error=str(error))
            rows.append(row)
    return {
        "scope": "Explicit canonical controls only; omitted controls are not certified.",
        "manifest": str(path.resolve()),
        "outputs": len(rows),
        "matched": sum(row["status"] == "matched" for row in rows),
        "mismatched": sum(row["status"] == "mismatch" for row in rows),
        "errors": sum(row["status"] == "error" for row in rows),
        "records": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = audit_manifest(args.manifest)
    serialized = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(serialized)
    print(json.dumps({key: value for key, value in report.items() if key != "records"}))
    return int(bool(report["mismatched"] or report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
