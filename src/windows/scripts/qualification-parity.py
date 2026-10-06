import argparse
import importlib
import json
import math
import sys
from pathlib import Path

from PIL import Image


def comparator():
    path = Path(__file__).resolve().parents[2] / "scripts" / "compare_images.py"
    directory = str(path.parent)
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module("compare_images")


def qualify(work: Path, budget: float) -> int:
    (work / "parity-verdict.json").unlink(missing_ok=True)
    if not math.isfinite(budget) or budget < 0:
        raise ValueError("Mean budget must be finite and non-negative")
    preview = work / "app-frame.png"
    reference = work / "ref-frame.png"
    export_result = json.loads(
        (work / "cpu" / "export-result.json").read_text(encoding="utf-8")
    )
    exported = Path(export_result["output"])
    gpu = work / "gpu-frame.png"
    gpu_report = json.loads((work / "gpu-pixels" / "report.json").read_text(encoding="utf-8"))
    if gpu_report["render_path"] != "gpu":
        raise ValueError("GPU pixel capture fell back to CPU")
    with Image.open(preview) as cpu_image, Image.open(gpu) as gpu_image:
        viewport = cpu_image.size
        if gpu_image.size != viewport:
            raise ValueError("GPU and CPU develop-frame dimensions differ")
    with Image.open(exported) as export_image, Image.open(reference) as ref_image:
        if export_image.size != ref_image.size:
            raise ValueError(
                f"Production export dimensions {export_image.size} differ "
                f"from the full reference {ref_image.size}"
            )
    comparisons = (
        ("preview", preview, reference, None),
        ("export", exported, reference, None),
        ("preview-export", preview, exported, None),
        ("gpu-reference-viewport", gpu, reference, viewport),
        ("gpu-export-viewport", gpu, exported, viewport),
        ("gpu-cpu-viewport", gpu, preview, viewport),
        ("cpu-reference-viewport", preview, reference, viewport),
        ("cpu-export-viewport", preview, exported, viewport),
    )
    verdict = {"mean_budget": budget}
    compare = comparator()
    for name, candidate, baseline, size in comparisons:
        result = compare.diff(str(candidate), str(baseline), reference_size=size)
        mean = result["mean_deltaE"]
        if not math.isfinite(mean) or mean < 0 or result["n_pixels"] <= 0:
            raise ValueError(f"Invalid perceptual metrics for {name}")
        (work / f"{name}-diff.json").write_text(
            json.dumps(result) + "\n", encoding="utf-8"
        )
        verdict[name.replace("-", "_") + "_parity_failed"] = mean > budget
    (work / "parity-verdict.json").write_text(
        json.dumps(verdict) + "\n", encoding="utf-8"
    )
    print(json.dumps(verdict))
    return int(any(value is True for value in verdict.values()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("work", nargs="?", type=Path)
    parser.add_argument("--budget", type=float, default=2.0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return comparator()._self_test()
    if args.work is None:
        parser.error("work is required unless --self-test is set")
    try:
        return qualify(args.work, args.budget)
    except (OSError, ValueError, KeyError, ImportError, TypeError) as error:
        print(f"Parity qualification tooling failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
