"""Measure removal scene probes through Maple's canonical comparator (#3941).

Uses a native central ROI so unchanged pixels cannot dilute the error.
Run with the environment used by src/scripts/compare_images.py.
"""

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image


def measure(directories, output, browser_directory=None):
    comparator_path = (
        Path(__file__).resolve().parents[2] / "src/scripts/compare_images.py"
    )
    spec = importlib.util.spec_from_file_location(
        "maple_compare_images", comparator_path
    )
    comparator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(comparator)
    output.mkdir(parents=True, exist_ok=True)
    mask = np.zeros((1024, 1024), dtype=np.uint8)
    mask[412:612, 412:612] = 255
    roi = output / "roi.png"
    Image.fromarray(mask).save(roi)
    cases = []
    for directory in directories:
        report = json.loads((directory / "report.json").read_text())
        if browser_directory:
            browser_report = json.loads((browser_directory / "report.json").read_text())
            for field in ("original", "native_context", "encoding"):
                if report[field] != browser_report[field]:
                    raise ValueError("Browser/native probe contexts differ")
        if report["outside_mask_max_error"] != 0:
            raise ValueError("Probe changed unselected source pixels")
        grades = []
        for truth in sorted(directory.glob("*-truth.png")):
            prefix = truth.name.removesuffix("-truth.png")
            identity = directory / f"{prefix}-identity.png"
            metrics = comparator.diff(str(identity), str(truth), roi_path=str(roi))
            if metrics["n_pixels"] != 40000:
                raise ValueError("Comparator did not measure the native removal ROI")
            grade = {"grade": prefix, "identity": metrics}
            if browser_directory:
                native = directory / f"{prefix}-removal.png"
                browser = browser_directory / f"{prefix}-removal.png"
                grade["browser_vs_native"] = comparator.diff(
                    str(browser), str(native), roi_path=str(roi)
                )
            grades.append(grade)
        if len(grades) != 18:
            raise ValueError("Expected all 18 Auto/Neutral exposure/camera-WB grades")
        cases.append(
            {"directory": str(directory), "scene_probe": report, "grades": grades}
        )
    results = {
        "cases": cases,
        "release_qualified": False,
        "qualification": "Native ROI colour diagnostics; photographic removal, seam and device gates remain",
    }
    (output / "report.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("directories", type=Path, nargs="+")
    parser.add_argument("--browser-directory", type=Path)
    args = parser.parse_args()
    results = measure(args.directories, args.output, args.browser_directory)
    for case in results["cases"]:
        print(
            json.dumps(
                {
                    "directory": case["directory"],
                    "identity_max_mean_deltaE": max(
                        grade["identity"]["mean_deltaE"] for grade in case["grades"]
                    ),
                    "identity_max_deltaE": max(
                        grade["identity"]["max_deltaE"] for grade in case["grades"]
                    ),
                    "browser_max_deltaE": max(
                        grade.get("browser_vs_native", {}).get("max_deltaE", 0)
                        for grade in case["grades"]
                    ),
                }
            )
        )


if __name__ == "__main__":
    main()
