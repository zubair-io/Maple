"""#3941: replay bounded native f32 boundary correction with artifact records.

Inputs are interleaved native f32 model-domain RGB and a binary coverage
domain PNG. Output is never clipped; out-of-model-domain values are reported
and must be rejected by the corresponding model-to-scene inverse.
"""

import argparse
import importlib.metadata
import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
from native_probe_pixels import digest
from native_seam_correction import PIXEL_BUDGET, correct
from PIL import Image


def run(source_path, prediction_path, domain_path, output):
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    with Image.open(domain_path) as image:
        if image.width * image.height > PIXEL_BUDGET:
            raise ValueError("Native correction domain exceeds the pixel budget")
        values = np.asarray(image)
    if values.ndim != 2 or not np.isin(values, [0, 255]).all():
        raise ValueError("Expected a single-channel binary native coverage domain")
    height, width = values.shape
    expected = height * width * 3
    if any(
        path.stat().st_size != expected * 4 for path in [source_path, prediction_path]
    ):
        raise ValueError("Float source/prediction length differs from native domain")
    arrays = [np.fromfile(path, dtype="<f4") for path in [source_path, prediction_path]]
    if any(array.size != expected for array in arrays):
        raise ValueError("Float source/prediction length differs from native domain")
    source, prediction = [array.reshape(height, width, 3) for array in arrays]
    domain = values == 255
    started = time.perf_counter()
    result, report = correct(source, prediction, domain)
    elapsed_ms = (time.perf_counter() - started) * 1000
    output.mkdir(parents=True, exist_ok=False)
    result.astype("<f4").tofile(output / "corrected.f32")
    result.transpose(2, 0, 1).copy().astype("<f4").tofile(output / "corrected-nchw.f32")
    # Rendering a preview does not change the f32 artifact used by the inverse.
    Image.fromarray(np.rint(np.clip(result, 0, 1) * 255).astype(np.uint8)).save(
        output / "display-preview.png"
    )
    report.update(
        {
            "source_sha256": digest(source_path),
            "prediction_sha256": digest(prediction_path),
            "domain_sha256": digest(domain_path),
            "native_extent_hw": [height, width],
            "source_resampled": False,
            "correction_ms": elapsed_ms,
            "model_domain_valid": bool(result.min() >= 0 and result.max() <= 1),
            "display_preview_scope": "Display-only clipped u8 visualization. Persisted f32 correction is unmodified, never clipped.",
            "correction_sha256": digest(output / "corrected.f32"),
            "process_peak_resident_bytes": resource.getrusage(
                resource.RUSAGE_SELF
            ).ru_maxrss
            * (1 if sys.platform == "darwin" else 1024),
            "toolchain": {
                p: importlib.metadata.version(p) for p in ["pyamg", "scipy", "numpy"]
            },
            "releaseQualified": False,
            "scope": "Native boundary correction research only; no RAW inverse, accepted record, editor/runtime, photographic corpus or hardware qualification is implied.",
        }
    )
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "prediction", "domain", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    run(args.source, args.prediction, args.domain, args.output)
