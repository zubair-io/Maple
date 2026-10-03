"""#3941: replay pinned public RAW Paint/protection qualification inputs.

Originals are read-only. Shared Rust generates the canonical native float
context and revalidates explicit MIMF intent/protection before preparing masks.
This prepares research inputs, never accepts an edit or changes app admission.
"""

import argparse
import json
import struct
import subprocess
from pathlib import Path

import numpy as np
from native_probe_pixels import digest
from PIL import Image


def rectangles(rows):
    values = np.zeros((1024, 1024), dtype=np.uint8)
    for x, y, width, height in rows:
        if min(x, y) < 0 or min(width, height) < 1 or max(x + width, y + height) > 1024:
            raise ValueError("Research rectangle exceeds its native context")
        values[y : y + height, x : x + width] = 255
    return values


def write_mask(path, values, context):
    window = context["window"]
    header = b"MIMF" + struct.pack(
        "<HH6I",
        1,
        0,
        context["source_width"],
        context["source_height"],
        window["x"],
        window["y"],
        1024,
        1024,
    )
    path.write_bytes(
        header + np.packbits((values > 0).reshape(-1), bitorder="little").tobytes()
    )


def prepare(case_id, raw_root, output, scene_probe):
    manifest = Path(__file__).with_name("photo-research-cases.json")
    data = json.loads(manifest.read_text())
    if data["version"] != 1 or data["releaseQualified"]:
        raise ValueError("Unsupported or qualified research manifest")
    matches = [case for case in data["cases"] if case["id"] == case_id]
    if len(matches) != 1:
        raise ValueError("Choose one recorded photographic research case")
    case = matches[0]
    pin = data["raws"][case["raw"]]
    if Path(pin["file"]).name != pin["file"]:
        raise ValueError("RAW research pin must name one local file")
    raw = raw_root / pin["file"]
    if raw.stat().st_size != pin["bytes"] or digest(raw) != pin["sha256"]:
        raise ValueError("RAW photographic fixture identity mismatch")
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    x, y, width, height = case["window_xywh"]
    if (width, height) != (1024, 1024):
        raise ValueError("These recorded RAW cases require native1024square")
    intent = rectangles(case["intent_rects_xywh"])
    protected = rectangles(case["protected_rects_xywh"])
    if not intent.any() or np.any((intent > 0) & (protected > 0)):
        raise ValueError("Empty intent or intent overlaps protected source")
    subprocess.run(
        [
            str(scene_probe),
            "encode",
            str(raw),
            str(x),
            str(y),
            str(output),
            "--linear-calibration",
        ],
        check=True,
        capture_output=True,
    )
    context = json.loads((output / "context.json").read_text())
    if (
        context["scene"] != case["expected_scene_blake3"]
        or context["model_input"] != case["expected_model_input_blake3"]
        or context["plate"] != "LinearCalibrationV1"
        or [context["window"][k] for k in ["x", "y", "width", "height"]]
        != case["window_xywh"]
    ):
        raise ValueError(
            "Canonical photographic context differs from the recorded case"
        )
    for name, values in [("intent", intent), ("protected", protected)]:
        write_mask(output / f"{name}.mimf", values, context)
    subprocess.run(
        [
            str(scene_probe),
            "masks",
            str(output),
            str(output / "intent.mimf"),
            "--protected",
            str(output / "protected.mimf"),
            "--hole-radius",
            str(case["hole_radius"]),
            "--fringe-radius",
            str(case["fringe_radius"]),
        ],
        check=True,
        capture_output=True,
    )
    planes = np.fromfile(output / "masks.f32", dtype="<f4").reshape(2, 1024, 1024)
    if (
        not np.isfinite(planes).all()
        or not np.isin(planes[0], [0, 1]).all()
        or np.any(planes[:, protected > 0])
    ):
        raise ValueError("Shared Rust mask preparation violates source protection")
    Image.fromarray((planes[0] * 255).astype(np.uint8)).save(output / "hole.png")
    Image.fromarray((planes[1] > 0).astype(np.uint8) * 255).save(output / "domain.png")
    source = np.fromfile(output / "input.f32", dtype="<f4").reshape(3, 1024, 1024)
    source.transpose(1, 2, 0).copy().tofile(output / "source-hwc.f32")
    if digest(raw) != pin["sha256"]:
        raise ValueError("Original RAW changed during photographic preparation")
    report = {
        "case": case,
        "manifest_sha256": digest(manifest),
        "RAW_sha256": digest(raw),
        "scene_probe_sha256": digest(scene_probe),
        "context": context,
        "hole_pixels": int(planes[0].sum()),
        "coverage_pixels": int((planes[1] > 0).sum()),
        "protected_pixels": int((protected > 0).sum()),
        "releaseQualified": False,
    }
    (output / "preparation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    for name in ["raw-root", "output", "scene-probe"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.case, args.raw_root, args.output, args.scene_probe)
