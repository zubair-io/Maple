#!/usr/bin/env python3
"""ACR +/-1 EV response regression gate (#3631), using actual Maple renders."""

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from tone_sprint_report import curve, lstar

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "test-fixtures/tone-exposure"
FIXTURES = ("test_0002", "test_0017")
CASES = ("exposure_p1", "exposure_m1")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_corpus():
    provenance = json.loads((CORPUS / "provenance.json").read_text())
    if set(provenance["fixtures"]) != set(FIXTURES):
        raise ValueError("reference corpus must contain both Exposure fixtures")
    for fixture in FIXTURES:
        for case in ("baseline", *CASES):
            record = provenance["fixtures"][fixture]["cases"][case]
            for extension in ("png", "xmp"):
                path = CORPUS / fixture / f"{case}.{extension}"
                if sha256(path) != record[f"{extension}_sha256"]:
                    raise ValueError(f"reference integrity mismatch: {path}")
    return provenance


def prepare_manifest(raw_root, destination):
    provenance = verify_corpus()
    paths = [raw_root / provenance["fixtures"][f]["raw"] for f in FIXTURES]
    if not any(path.is_file() for path in paths):
        print("tone-exposure: skipping — neither gitignored RAW fixture is present")
        return 3
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            "partially provisioned RAW fixtures: " + ", ".join(missing)
        )
    cases = []
    for fixture, raw in zip(FIXTURES, paths):
        if sha256(raw) != provenance["fixtures"][fixture]["raw_sha256"]:
            raise ValueError(f"RAW identity differs from calibrated fixture: {raw}")
        cases.append(
            {
                "name": f"{fixture}/baseline",
                "raw": str(raw.resolve()),
                "xmp": str(CORPUS / fixture / "baseline.xmp"),
            }
        )
    destination.write_text(json.dumps({"cases": cases}, indent=2) + "\n")
    return 0


def measure(base, edited, reference_base, reference_edited):
    arrays = (base, edited, reference_base, reference_edited)
    if base.size == 0 or any(a.shape != base.shape for a in arrays):
        raise ValueError("empty or mismatched image dimensions")
    if not all(np.isfinite(a).all() for a in arrays):
        raise ValueError("non-finite image values")
    actual = edited - base
    expected = reference_edited - reference_base
    # The reference sets spatial masks; each renderer supplies its OWN delta.
    actual_bands = curve(reference_base, reference_base + actual)
    expected_bands = curve(reference_base, reference_edited)
    valid = np.isfinite(actual_bands) & np.isfinite(expected_bands)
    if not valid.any():
        raise ValueError("no populated ACR baseline bands")
    expected_mean = float(expected.mean())
    if abs(expected_mean) < 1e-6:
        raise ValueError("degenerate ACR Exposure reference")
    actual_mean = float(actual.mean())
    return {
        "band_mae": float(np.mean(abs(actual_bands[valid] - expected_bands[valid]))),
        "maple_mean_delta_lstar": actual_mean,
        "acr_mean_delta_lstar": expected_mean,
        "signed_response_ratio": actual_mean / expected_mean,
        "bands": int(valid.sum()),
    }


def failures(metrics, limits, sign):
    problems = []
    if sign * metrics["acr_mean_delta_lstar"] <= 0:
        problems.append("reference has the wrong Exposure direction")
    if sign * metrics["maple_mean_delta_lstar"] <= 0:
        problems.append("Maple has the wrong Exposure direction")
    if metrics["band_mae"] > limits["band_mae"]:
        problems.append("band MAE exceeds budget")
    if metrics["signed_response_ratio"] > limits["response_ratio_max"]:
        problems.append("mean response overamplifies ACR")
    return problems


def candidate_paths(directory):
    paths = {
        (fixture, case): directory / f"{fixture}_auto_{case}.png"
        for fixture in FIXTURES
        for case in ("baseline", *CASES)
    }
    missing = [str(path) for path in paths.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError("incomplete production outputs: " + ", ".join(missing))
    return paths


def evaluate(directory):
    provenance = verify_corpus()
    budgets = json.loads((CORPUS / "budgets.json").read_text())
    paths = candidate_paths(directory)
    failed = False
    for fixture in FIXTURES:
        images = {}
        for case in ("baseline", *CASES):
            path = paths[fixture, case]
            record = provenance["fixtures"][fixture]["cases"][case]
            with Image.open(path) as image:
                if image.size != (record["width"], record["height"]):
                    raise ValueError(f"wrong production render dimensions: {path}")
            images[case] = lstar(path)
        reference_base = lstar(CORPUS / fixture / "baseline.png")
        for case, sign in zip(CASES, (1, -1)):
            metrics = measure(
                images["baseline"],
                images[case],
                reference_base,
                lstar(CORPUS / fixture / f"{case}.png"),
            )
            problems = failures(metrics, budgets[fixture][case], sign)
            failed |= bool(problems)
            print(
                json.dumps(
                    {"fixture": fixture, "case": case, **metrics, "failures": problems}
                )
            )
    print("tone-exposure: FAIL" if failed else "tone-exposure: PASS (4 comparisons)")
    return int(failed)


def self_test():
    # Mathematical test vectors only, never presented as production renders.
    base = np.tile(np.linspace(10.0, 89.0, 1600), (3, 1))
    for sign in (1, -1):
        target = base + sign * 5
        exact = measure(base, target, base, target)
        assert not failures(exact, {"band_mae": 0.01, "response_ratio_max": 1.1}, sign)
        flipped = measure(base, base - sign * 5, base, target)
        assert "Maple has the wrong Exposure direction" in failures(
            flipped, {"band_mae": 100, "response_ratio_max": 1.1}, sign
        )
        doubled = measure(base, base + sign * 10, base, target)
        assert "mean response overamplifies ACR" in failures(
            doubled, {"band_mae": 100, "response_ratio_max": 1.1}, sign
        )
        assert "band MAE exceeds budget" in failures(
            doubled, {"band_mae": 0.01, "response_ratio_max": 100}, sign
        )
    with tempfile.TemporaryDirectory() as temp:
        try:
            candidate_paths(Path(temp))
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("empty output directory must fail closed")
    print("tone-exposure: self-test PASS (both signs, 2x response, missing outputs)")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--candidates", type=Path)
    mode.add_argument("--prepare", type=Path, metavar="MANIFEST")
    mode.add_argument("--self-test", action="store_true")
    parser.add_argument("--raw-root", type=Path, default=ROOT / "test-fixtures/raws")
    args = parser.parse_args()
    try:
        if args.self_test:
            return self_test()
        if args.prepare:
            return prepare_manifest(args.raw_root, args.prepare)
        return evaluate(args.candidates)
    except (OSError, ValueError, KeyError) as error:
        print(f"tone-exposure: FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
