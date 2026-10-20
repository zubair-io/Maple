"""Bounded affine/radial reference sampling; candidate pixels and limits stay fixed."""

import hashlib
from pathlib import Path

import auto_profile_radial as radial
import auto_profile_radial_geometry as radial_geometry
import auto_profile_registration as registration
import numpy as np

POLICY = {
    "minimum_overlap": 0.95,
    "minimum_tile_overlap": 0.75,
    "tile_grid": 8,
    "maximum_affine_deviation": 0.10,
    "minimum_initial_correlation": 0.8,
    "minimum_final_correlation": 0.6,
}


def coordinates(shape, warp, start, stop):
    h, w = shape[:2]
    u = (np.arange(w, dtype=float)[None, :] + 0.5) / w
    v = (np.arange(start, stop, dtype=float)[:, None] + 0.5) / h
    px = (warp[0, 0] * u + warp[0, 1] * v + warp[0, 2]) * w - 0.5
    py = (warp[1, 0] * u + warp[1, 1] * v + warp[1, 2]) * h - 0.5
    valid = (px >= -1e-7) & (px <= w - 1 + 1e-7) & (py >= -1e-7) & (py <= h - 1 + 1e-7)
    return np.clip(px, 0, w - 1), np.clip(py, 0, h - 1), valid


def resample_reference(reference, warp):
    if np.array_equal(warp, registration.IDENTITY):
        return reference, np.ones(reference.shape[:2], dtype=bool)
    result = np.empty_like(reference)
    valid = np.empty(reference.shape[:2], dtype=bool)
    h, w = reference.shape[:2]
    for start in range(0, h, 64):
        stop = min(start + 64, h)
        px, py, mask = coordinates(reference.shape, warp, start, stop)
        x, y = np.floor(px).astype(int), np.floor(py).astype(int)
        fx, fy = (px - x)[..., None], (py - y)[..., None]
        a, b = reference[y, x], reference[y, np.minimum(x + 1, w - 1)]
        c, d = (
            reference[np.minimum(y + 1, h - 1), x],
            reference[np.minimum(y + 1, h - 1), np.minimum(x + 1, w - 1)],
        )
        result[start:stop] = (a * (1 - fx) + b * fx) * (1 - fy) + (
            c * (1 - fx) + d * fx
        ) * fy
        valid[start:stop] = mask
    return result, valid


def resample_report(reference, report):
    """Apply the exact display correspondence at native preview resolution."""
    warp = np.array(report["candidate_to_reference_normalized"])
    model = report.get("radial_model")
    if model is None:
        return resample_reference(reference, warp)
    return radial_geometry.resample(
        reference, warp, np.array(model["coefficients"]), np.array(model["fit_size"])
    )


def coverage(shape, warp):
    valid = np.concatenate(
        [
            coordinates(shape, warp, start, min(start + 64, shape[0]))[2]
            for start in range(0, shape[0], 64)
        ]
    )
    tiles = [
        {"row": y, "column": x, "fraction": float(tile.mean())}
        for y, row in enumerate(np.array_split(valid, 8, axis=0))
        for x, tile in enumerate(np.array_split(row, 8, axis=1))
    ]
    return float(valid.mean()), tiles


def align(candidate, reference):
    error = None
    try:
        warp, levels = registration.estimate(candidate, reference)
    except (ValueError, np.linalg.LinAlgError) as failure:
        warp, levels, error = registration.IDENTITY.copy(), [], str(failure)
    forward, tiles = coverage(reference.shape, warp)
    inverse = np.linalg.inv(np.vstack([warp, [0, 0, 1]]))[:2]
    backward, reverse_tiles = coverage(reference.shape, inverse)
    breaches = []
    if error:
        breaches.append({"metric": "structural_correspondence", "reason": error})
    for direction, overlap, cells in [
        ("candidate", forward, tiles),
        ("reference", backward, reverse_tiles),
    ]:
        if overlap < POLICY["minimum_overlap"]:
            breaches.append(
                {
                    "metric": "geometry_overlap",
                    "direction": direction,
                    "value": overlap,
                    "limit": POLICY["minimum_overlap"],
                }
            )
        for cell in cells:
            if cell["fraction"] < POLICY["minimum_tile_overlap"]:
                breaches.append(
                    {
                        "metric": "geometry_tile_overlap",
                        "direction": direction,
                        **cell,
                        "limit": POLICY["minimum_tile_overlap"],
                    }
                )
    aligned, valid = resample_reference(reference, warp)
    radial_model, radial_report = None, {"reason": "affine geometry failed"}
    if not breaches and not np.array_equal(candidate, reference):
        coefficients, radial_report = radial.fit_residual(candidate, aligned, valid)
        if coefficients is not None:
            size = np.array(reference.shape[1::-1])
            try:
                checks = radial_geometry.geometry_checks(
                    reference.shape, warp, coefficients, size
                )
                radial_report["checks"] = checks
                if not checks["breaches"]:
                    aligned, valid = radial_geometry.resample(
                        reference, warp, coefficients, size
                    )
                    radial_model = {
                        "coefficients": coefficients.tolist(),
                        "fit_size": size.tolist(),
                    }
                    forward = checks["regions"]["candidate"]["coverage"]
                    backward = checks["regions"]["reference"]["coverage"]
                    tiles = checks["regions"]["candidate"]["tiles"]
                    reverse_tiles = checks["regions"]["reference"]["tiles"]
            except (ValueError, np.linalg.LinAlgError) as failure:
                radial_report["rejected"] = str(failure)
    elif not breaches:
        radial_report = {"reason": "identical pixels"}
    return (
        aligned,
        valid,
        {
            "candidate_to_reference_normalized": warp.tolist(),
            "radial_model": radial_model,
            "radial_diagnostic": radial_report,
            "levels": levels,
            "candidate_overlap": forward,
            "reference_overlap": backward,
            "tiles": tiles,
            "reference_tiles": reverse_tiles,
            "policy": POLICY,
            "implementation_sha256": {
                Path(p).name: hashlib.sha256(Path(p).read_bytes()).hexdigest()
                for p in (
                    __file__,
                    registration.__file__,
                    radial.__file__,
                    radial_geometry.__file__,
                )
            },
            "breaches": breaches,
            "status": "failed" if breaches else "passed",
        },
    )
