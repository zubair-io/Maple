"""Resolution-independent composition and coverage for the radial experiment."""

import numpy as np


def forward(points, affine, coefficients, fit_size):
    """Map normalized candidate coordinates to original reference coordinates."""
    xy = points * 2 - 1 - 1 / fit_size
    linear = np.column_stack([np.ones(len(points)), xy])
    delta = (
        np.column_stack([linear @ coefficients[:3], linear @ coefficients[3:6]])
        / fit_size
    )
    delta += xy * (xy * xy).sum(axis=1)[:, None] * coefficients[6]
    return (points + delta) @ affine[:, :2].T + affine[:, 2]


def inverse(points, affine, coefficients, fit_size):
    """Invert the bounded residual using fixed-point iteration; fail closed."""
    target = (points - affine[:, 2]) @ np.linalg.inv(affine[:, :2]).T
    guess = target.copy()
    identity = np.array([[1.0, 0, 0], [0, 1.0, 0]])
    for _ in range(40):
        delta = forward(guess, identity, coefficients, fit_size) - guess
        guess = target - delta
    error = np.linalg.norm(
        forward(guess, affine, coefficients, fit_size) - points, axis=1
    )
    if not np.isfinite(error).all() or error.max() > 1e-7:
        raise ValueError("radial inverse did not converge")
    return guess


def geometry_checks(shape, affine, coefficients, fit_size):
    h, w = shape[:2]
    yy, xx = np.mgrid[:h, :w]
    points = np.column_stack([(xx.ravel() + 0.5) / w, (yy.ravel() + 0.5) / h])
    regions, breaches = {}, []
    for name, fn in [("candidate", forward), ("reference", inverse)]:
        mapped = fn(points, affine, coefficients, fit_size)
        support = (
            (
                (mapped >= [0.5 / w - 1e-10, 0.5 / h - 1e-10])
                & (mapped <= [1 - 0.5 / w + 1e-10, 1 - 0.5 / h + 1e-10])
            )
            .all(axis=1)
            .reshape(h, w)
        )
        tiles = [
            float(tile.mean())
            for rows in np.array_split(support, 8)
            for tile in np.array_split(rows, 8, axis=1)
        ]
        regions[name] = {"coverage": float(support.mean()), "minimum_tile": min(tiles)}
        if support.mean() < 0.95 or min(tiles) < 0.75:
            breaches.append(f"{name} coverage")
    # A dense regular grid checks orientation and deformation, independent
    # of where the scene happened to provide feature landmarks.
    gy, gx = np.mgrid[0:1:65j, 0:1:65j]
    grid = np.column_stack([gx.ravel(), gy.ravel()])
    mapped = forward(grid, affine, coefficients, fit_size)
    dx = (forward(grid + [1e-6, 0], affine, coefficients, fit_size) - mapped) / 1e-6
    dy = (forward(grid + [0, 1e-6], affine, coefficients, fit_size) - mapped) / 1e-6
    determinant = dx[:, 0] * dy[:, 1] - dx[:, 1] * dy[:, 0]
    if determinant.min() <= 0:
        breaches.append("folded geometry")
    displacement = float(np.abs(mapped - grid).max())
    if displacement > 0.10:
        breaches.append("geometry exceeds existing 10 percent bound")
    return {
        "regions": regions,
        "minimum_jacobian_determinant": float(determinant.min()),
        "maximum_normalized_displacement": displacement,
        "breaches": breaches,
    }


def resample(reference, affine, coefficients, fit_size):
    """One bilinear sample from the original reference, in bounded row blocks."""
    h, w = reference.shape[:2]
    result = np.empty_like(reference)
    support = np.empty((h, w), dtype=bool)
    for start in range(0, h, 64):
        stop = min(h, start + 64)
        yy, xx = np.mgrid[start:stop, :w]
        points = np.column_stack([(xx.ravel() + 0.5) / w, (yy.ravel() + 0.5) / h])
        mapped = forward(points, affine, coefficients, fit_size) * [w, h] - 0.5
        px, py = mapped[:, 0], mapped[:, 1]
        valid = (
            (px >= -1e-7) & (py >= -1e-7) & (px <= w - 1 + 1e-7) & (py <= h - 1 + 1e-7)
        )
        px, py = np.clip(px, 0, w - 1), np.clip(py, 0, h - 1)
        x, y = np.floor(px).astype(int), np.floor(py).astype(int)
        fx, fy = (px - x)[:, None], (py - y)[:, None]
        a, b = reference[y, x], reference[y, np.minimum(x + 1, w - 1)]
        c, d = (
            reference[np.minimum(y + 1, h - 1), x],
            reference[np.minimum(y + 1, h - 1), np.minimum(x + 1, w - 1)],
        )
        result[start:stop] = (
            (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
        ).reshape(stop - start, w, 3)
        support[start:stop] = valid.reshape(stop - start, w)
    return result, support
