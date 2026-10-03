import argparse
import importlib
import json
import math
import sys
from pathlib import Path

from PIL import Image


def comparator():
    path = Path(__file__).resolve().parents[2] / "scripts" / "compare_images.py"
    sys.path.insert(0, str(path.parent))
    return importlib.import_module("compare_images")


def qualify(work: Path, budget: float) -> int:
    (work / "parity-verdict.json").unlink(missing_ok=True)
    if not math.isfinite(budget) or budget < 0:
        raise ValueError("Mean budget must be finite and non-negative")
    preview = work / "app-frame.png"
    reference = work / "ref-frame.png"
    export_result = json.loads((work / "cpu" / "export-result.json").read_text())
    exported = Path(export_result["output"])
    with Image.open(exported) as export_image, Image.open(reference) as ref_image:
        if export_image.size != ref_image.size:
            raise ValueError(
                f"Production export dimensions {export_image.size} differ "
                f"from the full reference {ref_image.size}"
            )
    comparisons = (
        ("preview", preview, reference),
        ("export", exported, reference),
        ("preview-export", preview, exported),
    )
    verdict = {"mean_budget": budget}
    compare = comparator()
    for name, candidate, baseline in comparisons:
        result = compare.diff(str(candidate), str(baseline))
        mean = result["mean_deltaE"]
        if not math.isfinite(mean) or mean < 0 or result["n_pixels"] <= 0:
            raise ValueError(f"Invalid perceptual metrics for {name}")
        (work / f"{name}-diff.json").write_text(json.dumps(result) + "\n")
        verdict[name.replace("-", "_") + "_parity_failed"] = mean > budget
    (work / "parity-verdict.json").write_text(json.dumps(verdict) + "\n")
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
    except Exception as error:
        print(f"Parity qualification tooling failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
