"""#3941: derive an explicit research intent using shared native Rust expansion.

Never changes the parent context, source file or application mask policy. The
derived mask remains an experimental selection, not independent closure truth.
"""

import argparse
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from native_probe_pixels import digest
from PIL import Image


def derive(context, scene_probe, radius, output):
    if output.exists():
        raise ValueError("Choose a fresh edge derivation directory")
    if radius != 16:
        raise ValueError("This recorded experiment requires native radius16")
    recipe = json.loads((context / "context.json").read_text())
    if (
        recipe["release_qualified"]
        or recipe["window"]["width"] != 1024
        or recipe["window"]["height"] != 1024
    ):
        raise ValueError("Expected an unqualified native1024 context")
    files = ("context.json", "scene.f32", "input.f32", "intent.mimf", "protected.mimf")
    identities = {name: digest(context / name) for name in files}
    output.mkdir()
    for name in files:
        shutil.copyfile(context / name, output / name)
    subprocess.run(
        [
            str(scene_probe),
            "masks",
            str(output),
            str(output / "intent.mimf"),
            "--protected",
            str(output / "protected.mimf"),
            "--hole-radius",
            str(radius),
            "--fringe-radius",
            "0",
        ],
        check=True,
        capture_output=True,
    )
    planes = np.fromfile(output / "masks.f32", dtype="<f4")
    if planes.size != 2 * 1024 * 1024 or not np.isfinite(planes).all():
        raise ValueError("Invalid shared native generation planes")
    hole = planes[: 1024 * 1024].reshape(1024, 1024)
    if not np.isin(hole, [0, 1]).all() or not hole.any() or hole.all():
        raise ValueError("Expected a binary nonempty bounded native hole")
    mask = output / "expanded-intent.png"
    Image.fromarray((hole * 255).astype(np.uint8)).save(mask)
    if any(digest(context / name) != expected for name, expected in identities.items()):
        raise ValueError("Parent context changed during edge derivation")
    report = {
        "radius": radius,
        "native_extent_hw": [1024, 1024],
        "expanded_intent_pixels": int(np.count_nonzero(hole)),
        "expanded_intent_sha256": digest(mask),
        "scene_probe_sha256": digest(scene_probe),
        "parent_files_sha256": identities,
        "shared_masks_recipe": json.loads((output / "masks.json").read_text()),
        "source_resampled": False,
        "releaseQualified": False,
        "scope": "Actual shared native Euclidean expansion with explicit source protection. A research coverage control, not labeled object ownership/closure or a shipping policy.",
    }
    (output / "derivation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("context", "scene-probe", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--radius", type=int, required=True)
    args = parser.parse_args()
    derive(args.context, args.scene_probe, args.radius, args.output)
