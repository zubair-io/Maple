#!/usr/bin/env python3
"""Auto and Neutral Whites response gate (#3601), separate from Neutral color gates."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from tone_sprint_report import lstar

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "test-fixtures/tone-whites"
MANIFEST = ROOT / "test-fixtures/references/manifest.json"
FIXTURES = tuple(f"test_{i:04d}" for i in (*range(16), 17, 18))
CASES = ("baseline", "whites_max", "whites_min")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_contract():
    provenance = json.loads((CORPUS / "provenance.json").read_text())
    budgets = json.loads((CORPUS / "budgets.json").read_text())
    if set(provenance["fixtures"]) != set(FIXTURES) or set(budgets) != {
        "auto",
        "neutral",
    }:
        raise ValueError("Whites contract must contain all 18 fixtures")
    for fixture in FIXTURES:
        if set(provenance["fixtures"][fixture]["cases"]) != set(CASES):
            raise ValueError(f"incomplete reference contract: {fixture}")
        for profile in ("auto", "neutral"):
            if set(budgets[profile]) != set(FIXTURES):
                raise ValueError(f"incomplete profile budgets: {profile}")
            if set(budgets[profile][fixture]) != set(CASES[1:]):
                raise ValueError(f"missing response rail budget: {profile}/{fixture}")
            for limit in budgets[profile][fixture].values():
                if not np.isfinite(limit["band_mae"]) or limit["band_mae"] <= 0:
                    raise ValueError("invalid response budget")
    return provenance, budgets


def select_cases(manifest):
    wanted = {f"{f}/{c}" for f in FIXTURES for c in CASES}
    selected = {}
    for entry in manifest["cases"]:
        if entry["name"] in wanted:
            if entry["name"] in selected:
                raise ValueError(f"duplicate manifest case: {entry['name']}")
            selected[entry["name"]] = entry
    missing = wanted - selected.keys()
    if missing:
        raise ValueError("incomplete manifest: " + ", ".join(sorted(missing)))
    return selected


def reference_path(entry):
    outputs = [o for o in entry["outputs"] if o["resolution"] == "down"]
    if len(outputs) != 1:
        raise ValueError(f"one down reference required: {entry['name']}")
    return Path(outputs[0]["png"])


def verify_file(path, digest):
    if sha256(path) != digest:
        raise ValueError(f"reference/input integrity mismatch: {path}")


def verify_inputs(selected, provenance, *, require_raw):
    for fixture in FIXTURES:
        record = provenance["fixtures"][fixture]
        raw_paths = {selected[f"{fixture}/{c}"]["raw"] for c in CASES}
        if len(raw_paths) != 1:
            raise ValueError(f"inconsistent RAW identity: {fixture}")
        if require_raw:
            verify_file(Path(next(iter(raw_paths))), record["raw_sha256"])
        for case in CASES:
            entry = selected[f"{fixture}/{case}"]
            expected = record["cases"][case]
            verify_file(Path(entry["xmp"]), expected["maple_xmp_sha256"])
            reference = reference_path(entry)
            verify_file(reference, expected["reference_png_sha256"])
            with Image.open(reference) as image:
                if list(image.size) != expected["reference_size"]:
                    raise ValueError(f"wrong reference dimensions: {reference}")


def prepare(destination, manifest_path=MANIFEST):
    provenance, _ = read_contract()
    if not manifest_path.exists():
        references = ROOT / "test-fixtures/references"
        if any(
            (references / f / "down" / f"{c}.png").exists()
            for f in FIXTURES
            for c in CASES
        ):
            raise ValueError("references present but manifest missing")
        print("tone-whites: skipping — gitignored reference corpus is absent")
        return 3
    selected = select_cases(json.loads(manifest_path.read_text()))
    raws = [Path(selected[f"{f}/baseline"]["raw"]) for f in FIXTURES]
    if not any(p.exists() for p in raws):
        print("tone-whites: skipping — all 18 gitignored RAW fixtures are absent")
        return 3
    # A present manifest/corpus with incomplete assets fails closed.
    verify_inputs(selected, provenance, require_raw=True)
    destination.write_text(
        json.dumps({"cases": list(selected.values())}, indent=2) + "\n"
    )
    return 0


def measure(base, edited, reference_base, reference_edited):
    arrays = (base, edited, reference_base, reference_edited)
    if base.size == 0 or any(a.shape != base.shape for a in arrays):
        raise ValueError("empty or mismatched response arrays")
    if not all(np.isfinite(a).all() for a in arrays):
        raise ValueError("non-finite response values")
    actual = edited - base
    expected = reference_edited - reference_base
    if np.any(reference_base < 0) or np.any(reference_base > 100 + 1e-9):
        raise ValueError("ACR baseline luminance outside display range")
    # Spatial masks come ONLY from ACR baseline. The final band includes
    # exact display white (L*=100), which Whites- must also be able to move.
    bins = np.minimum((reference_base / 5).astype(np.int32), 19).ravel()
    counts = np.bincount(bins, minlength=20)
    actual_bands = np.bincount(bins, weights=actual.ravel(), minlength=20) / np.maximum(
        counts, 1
    )
    expected_bands = np.bincount(
        bins, weights=expected.ravel(), minlength=20
    ) / np.maximum(counts, 1)
    valid = counts >= 200
    if not valid.any():
        raise ValueError("no populated ACR baseline bands")
    return {
        "band_mae": float(np.mean(abs(actual_bands[valid] - expected_bands[valid]))),
        "maple_mean_delta_lstar": float(actual.mean()),
        "acr_mean_delta_lstar": float(expected.mean()),
        "bands": int(valid.sum()),
    }


def failures(metrics, limit, sign):
    errors = []
    if not all(np.isfinite(v) for v in metrics.values()):
        return ["non-finite metrics"]
    if sign * metrics["acr_mean_delta_lstar"] <= 0:
        errors.append("wrong reference response direction")
    if sign * metrics["maple_mean_delta_lstar"] <= 0:
        errors.append("wrong Maple response direction")
    if metrics["band_mae"] > limit["band_mae"]:
        errors.append(f"band MAE {metrics['band_mae']:.6f} > {limit['band_mae']:.6f}")
    return errors


def candidate_paths(directory, provenance):
    paths = {}
    for fixture in FIXTURES:
        for case in CASES:
            path = directory / f"{fixture}_{case}.png"
            with Image.open(path) as image:
                if list(image.size) != provenance["fixtures"][fixture]["native_size"]:
                    raise ValueError(f"wrong native candidate dimensions: {path}")
            paths[f"{fixture}/{case}"] = path
    return paths


def evaluate(directory, profile="auto", manifest_path=MANIFEST):
    provenance, budgets = read_contract()
    selected = select_cases(json.loads(manifest_path.read_text()))
    verify_inputs(selected, provenance, require_raw=False)
    paths = candidate_paths(directory, provenance)
    failed = 0
    for fixture in FIXTURES:
        reference_base = lstar(reference_path(selected[f"{fixture}/baseline"]))
        size = (reference_base.shape[1], reference_base.shape[0])
        base = lstar(paths[f"{fixture}/baseline"], size)
        for case, sign in (("whites_max", 1), ("whites_min", -1)):
            metrics = measure(
                base,
                lstar(paths[f"{fixture}/{case}"], size),
                reference_base,
                lstar(reference_path(selected[f"{fixture}/{case}"])),
            )
            errors = failures(metrics, budgets[profile][fixture][case], sign)
            failed += bool(errors)
            print(
                json.dumps(
                    dict(
                        profile=profile,
                        fixture=fixture,
                        case=case,
                        **metrics,
                        failures=errors,
                    )
                ),
                flush=True,
            )
    print(
        f"tone-whites {profile}: {'FAIL' if failed else 'PASS'} ({36 - failed}/36 response comparisons)"
    )
    return int(failed > 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--prepare", type=Path)
    group.add_argument("--candidates", type=Path)
    parser.add_argument("--profile", choices=("auto", "neutral"), default="auto")
    args = parser.parse_args()
    try:
        return (
            prepare(args.prepare)
            if args.prepare
            else evaluate(args.candidates, args.profile)
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"tone-whites: FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
