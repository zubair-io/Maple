"""Select radial correspondence using spatially held-out landmarks, never color scores."""

import cv2
import numpy as np


def landmarks(a, b, valid):
    cv2.setRNGSeed(0)

    def gray(image):
        return np.uint8(np.clip(image @ [0.2126, 0.7152, 0.0722], 0, 1) * 255)

    detector = cv2.SIFT_create(nfeatures=5000)
    ka, da = detector.detectAndCompute(gray(a), np.uint8(valid) * 255)
    kb, db = detector.detectAndCompute(gray(b), np.uint8(valid) * 255)
    if da is None or db is None or min(len(da), len(db)) < 2:
        return None
    matcher = cv2.BFMatcher()
    reverse = {
        m.queryIdx: m.trainIdx
        for m, n in matcher.knnMatch(db, da, k=2)
        if m.distance < 0.7 * n.distance
    }
    matches = [
        m
        for m, n in matcher.knnMatch(da, db, k=2)
        if m.distance < 0.7 * n.distance and reverse.get(m.trainIdx) == m.queryIdx
    ]
    if len(matches) < 80:
        return None
    x = np.float64([ka[m.queryIdx].pt for m in matches])
    y = np.float64([kb[m.trainIdx].pt for m in matches])
    _, good = cv2.findHomography(x, y, cv2.RANSAC, 4)
    if good is None:
        return None
    return x[good.ravel() != 0], y[good.ravel() != 0]


def basis(points, size, radial):
    xy = points / size * 2 - 1
    count = len(points)
    result = np.zeros((count, 2, 7 if radial else 6))
    result[:, 0, :3] = np.column_stack([np.ones(count), xy])
    result[:, 1, 3:6] = np.column_stack([np.ones(count), xy])
    if radial:
        result[:, :, 6] = xy * (xy * xy).sum(axis=1)[:, None] * size
    return result


def fit_residual(a, b, valid):
    found = landmarks(a, b, valid)
    if found is None:
        return None, {"reason": "insufficient landmarks"}
    x, y = found
    size = np.array(a.shape[1::-1])
    delta = y - x
    folds = (np.floor(x[:, 0] / 64) + np.floor(x[:, 1] / 64)).astype(int) % 2
    if min(np.bincount(folds, minlength=2)) < 30:
        return None, {"reason": "insufficient spatial holdout"}
    errors = {}
    for radial in [False, True]:
        design = basis(x, size, radial)
        residuals = []
        for fold in [0, 1]:
            train, test = folds != fold, folds == fold
            coeff = np.linalg.lstsq(
                design[train].reshape(-1, design.shape[-1]),
                delta[train].ravel(),
                rcond=None,
            )[0]
            residuals.extend(np.linalg.norm(design[test] @ coeff - delta[test], axis=1))
        errors["radial" if radial else "affine"] = float(np.median(residuals))
    info = {"landmarks": len(x), "held_out_median_px": errors}
    # Reject unhelpful flexibility, even if its color scores would improve.
    if errors["radial"] > errors["affine"] * 0.75:
        return None, {**info, "reason": "no substantial held-out geometry improvement"}
    design = basis(x, size, True)
    coeff = np.linalg.lstsq(design.reshape(-1, 7), delta.ravel(), rcond=None)[0]
    return coeff, {
        **info,
        "coefficients": coeff.tolist(),
        "reason": "geometry candidate",
    }
