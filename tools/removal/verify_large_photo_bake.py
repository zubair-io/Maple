"""#3941: independent native2048 known/protected display preservation checks.

This binds the actual canonical RAW context, model result and all 18 grade
images. It does not establish hidden-background quality or ACR/device parity.
"""

import argparse
import json
from pathlib import Path

import blake3
import numpy as np
from PIL import Image
from probe_lama_large_scene import SIDE, load_inputs, mask_values, sha256


def content_digest(data):
    return "blake3:" + blake3.blake3(data).hexdigest()


def verify(context, bake, result, output):
    if output.exists():
        raise ValueError("Choose a fresh verification output file")
    load_inputs(context)
    recipe = json.loads((context / "context.json").read_text())
    pins = json.loads((context / "inputs.json").read_text())
    report_path = bake / "report.json"
    report = json.loads(report_path.read_text())
    if (
        report["native_context"] != recipe["window"]
        or report["original"] != pins["source"]["original"]
        or report["plate"] != recipe["plate"]
        or report["generation_masks"]
        != content_digest((context / "masks.f32").read_bytes())
        or report["model_result"] != content_digest(result.read_bytes())
        or report["outside_mask_max_error"] != 0
    ):
        raise ValueError("Bake differs from bound native source, masks or model result")
    planes = np.fromfile(context / "masks.f32", "<f4").reshape(2, SIDE, SIDE)
    expected_coverage = planes[1] > 0
    with Image.open(bake / "coverage.png") as image:
        coverage = np.asarray(image)
    if (
        coverage.shape != (SIDE, SIDE)
        or not np.isin(coverage, [0, 255]).all()
        or not np.array_equal(coverage > 0, expected_coverage)
    ):
        raise ValueError("Bake coverage differs from actual shared native mask")
    (x, y, _w, _h), protected = mask_values(
        (context / "protected.mimf").read_bytes(), pins["source"]
    )
    ys, xs = np.nonzero(protected)
    tx = xs + x - recipe["window"]["x"]
    ty = ys + y - recipe["window"]["y"]
    inside = (tx >= 0) & (ty >= 0) & (tx < SIDE) & (ty < SIDE)
    native_protection = np.zeros((SIDE, SIDE), bool)
    native_protection[ty[inside], tx[inside]] = True
    if not native_protection.any() or np.any(native_protection & expected_coverage):
        raise ValueError(
            "No protected native samples or replacement crosses protection"
        )
    cases = [row["case"] for row in report["grades"]]
    expected_cases = {
        f"{profile}_ev{ev:+d}_wb{wb:+d}"
        for profile in ["neutral", "auto"]
        for ev in [-3, 0, 3]
        for wb in [-1000, 0, 1000]
    }
    if len(cases) != 18 or set(cases) != expected_cases:
        raise ValueError("Missing, repeated or unexpected native grade cases")
    rows = []
    for case in cases:
        paths = [
            bake / f"{case}-{owner}.png" for owner in ["truth", "identity", "removal"]
        ]
        images = []
        for path in paths:
            with Image.open(path) as image:
                if image.mode != "RGB" or image.size != (SIDE, SIDE):
                    raise ValueError("Expected native2048 RGB grade image")
                images.append(np.asarray(image))
        truth, identity, removal = images
        counts = {
            "outside_u8_samples_changed": int(
                np.count_nonzero(
                    removal[~expected_coverage] != truth[~expected_coverage]
                )
            ),
            "protected_u8_samples_changed": int(
                np.count_nonzero(removal[native_protection] != truth[native_protection])
            ),
            "identity_outside_u8_samples_changed": int(
                np.count_nonzero(
                    identity[~expected_coverage] != truth[~expected_coverage]
                )
            ),
        }
        if any(counts.values()):
            raise ValueError(f"Known/protected grade sample changed: {case}")
        rows.append(
            {"case": case, **counts, "fileSHA256": {p.name: sha256(p) for p in paths}}
        )
    evidence = {
        "source": pins["source"],
        "window": recipe["window"],
        "contextSHA256": sha256(context / "context.json"),
        "bakeReportSHA256": sha256(report_path),
        "modelResultSHA256": sha256(result),
        "protectedDigest": pins["protected"],
        "protectedNativePixels": int(native_protection.sum()),
        "coverageNativePixels": int(expected_coverage.sum()),
        "grades": rows,
        "releaseQualified": False,
        "scope": "Independent display preservation at every known/protected native pixel for all 18 grade images; not hidden-background quality, ACR color parity, app flow or controlled-device qualification.",
    }
    output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"All {len(rows)} native2048 grade comparisons passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["context", "bake", "result", "output"]:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    verify(args.context, args.bake, args.result, args.output)
