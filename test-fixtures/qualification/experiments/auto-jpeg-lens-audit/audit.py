"""Diagnostic landmarks after existing alignment; never changes gate pixels."""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def audit(candidate, reference, valid):
    def gray(image):
        return np.uint8(np.clip(image @ [0.2126, 0.7152, 0.0722], 0, 1) * 255)

    detector = cv2.SIFT_create(nfeatures=5000)
    mask = np.uint8(valid) * 255
    ka, da = detector.detectAndCompute(gray(candidate), mask)
    kb, db = detector.detectAndCompute(gray(reference), mask)
    matcher = cv2.BFMatcher()
    forward = matcher.knnMatch(da, db, k=2)
    reverse = matcher.knnMatch(db, da, k=2)
    reverse_good = {
        m.queryIdx: m.trainIdx for m, n in reverse if m.distance < 0.7 * n.distance
    }
    matches = [
        m
        for m, n in forward
        if m.distance < 0.7 * n.distance and reverse_good.get(m.trainIdx) == m.queryIdx
    ]
    a = np.float32([ka[m.queryIdx].pt for m in matches])
    b = np.float32([kb[m.trainIdx].pt for m in matches])
    if len(a) < 12:
        return {"status": "insufficient landmarks", "matches": len(a)}, None
    # Used only to reject mismatches. It does NOT warp evaluated colors.
    _, inliers = cv2.findHomography(a, b, cv2.RANSAC, 4.0)
    if inliers is None:
        return {"status": "unreliable landmarks", "matches": len(a)}, None
    a, b = a[inliers.ravel() != 0], b[inliers.ravel() != 0]
    h, w = valid.shape
    radius = np.linalg.norm((a / [w, h] - 0.5) * 2, axis=1)
    delta = b - a
    distance = np.linalg.norm(delta, axis=1)
    # Spatially held-out diagnostic: does a radial term explain geometry
    # better than another affine fit? Neither model changes the comparator.
    xy = (a / [w, h] - 0.5) * 2
    r2 = (xy * xy).sum(axis=1)
    affine = np.column_stack([np.ones(len(a)), xy])
    radial = np.column_stack([affine, xy * r2[:, None]])
    folds = (np.floor(a[:, 0] / 64) + np.floor(a[:, 1] / 64)).astype(int) % 2
    predictions = {}
    for label, basis in [("affine", affine), ("affine_plus_radial", radial)]:
        errors = []
        for fold in (0, 1):
            train, test = folds != fold, folds == fold
            if train.sum() < 20 or test.sum() < 20:
                continue
            coefficients = np.linalg.lstsq(basis[train], delta[train], rcond=None)[0]
            errors.extend(
                np.linalg.norm(basis[test] @ coefficients - delta[test], axis=1)
            )
        predictions[label] = float(np.median(errors)) if errors else None
    yy, xx = np.mgrid[:h, :w]
    pixel_radius = np.hypot((xx + 0.5) / w * 2 - 1, (yy + 0.5) / h * 2 - 1)
    signed = (candidate - reference) @ [0.2126, 0.7152, 0.0722]
    regions = {}
    for name, lo, hi in [("center", 0, 0.5), ("middle", 0.5, 0.9), ("outer", 0.9, 2)]:
        landmarks = (radius >= lo) & (radius < hi)
        pixels = valid & (pixel_radius >= lo) & (pixel_radius < hi)
        regions[name] = {
            "landmarks": int(landmarks.sum()),
            "median_displacement_px": float(np.median(distance[landmarks]))
            if landmarks.any()
            else None,
            "p95_displacement_px": float(np.quantile(distance[landmarks], 0.95))
            if landmarks.any()
            else None,
            "signed_display_luma": float(signed[pixels].mean()),
            "absolute_display_luma": float(np.abs(signed[pixels]).mean()),
        }
    canvas = Image.fromarray(np.uint8(np.clip(candidate, 0, 1) * 255))
    draw = ImageDraw.Draw(canvas)
    for start, movement in zip(a, delta):
        x, y = map(float, start)
        end = start + movement * 10
        draw.line((x, y, float(end[0]), float(end[1])), fill="yellow", width=2)
        draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill="red")
    return {
        "status": "measured",
        "mutual_matches": len(matches),
        "inlier_landmarks": len(a),
        "size": [w, h],
        "held_out_geometry_median_error_px": predictions,
        "regions": regions,
    }, canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("scripts", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    import auto_profile_alignment as alignment
    import auto_profile_quality as quality

    cv2.setRNGSeed(0)
    summary = json.loads((args.checkpoint / "full-suite/summary.json").read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for row in summary["cases"]:
        if "quality" not in row:
            continue
        folder = args.checkpoint / "full-suite" / row["fixture"]
        candidate, reference = quality.load_display_pair(
            folder / "auto.png", folder / "embedded.png"
        )
        warp = np.array(
            row["quality"]["alignment"]["candidate_to_reference_normalized"]
        )
        reference, valid = alignment.resample_reference(reference, warp)
        measured, canvas = audit(candidate, reference, valid)
        measured.update(
            fixture=row["fixture"],
            photographic_status=row["status"],
            candidate_sha256=row["candidate_sha256"],
            reference_sha256=row["reference_sha256"],
        )
        records.append(measured)
        if canvas:
            canvas.save(args.output / f"{row['fixture']}-landmarks.png")
        print(row["fixture"], measured["status"], flush=True)
    assert len(records) == 16
    result = {
        "diagnostic_only": True,
        "limitations": [
            "Landmarks are texture-selected; sky and flat surfaces are not measured.",
            "Homography RANSAC rejects gross mismatches and may exclude strong local warps.",
            "Brightness bands have different scene content; they do not prove vignetting.",
            "Vectors are enlarged 10x. No thresholds or gate pixels are changed.",
        ],
        "cases": records,
    }
    (args.output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
