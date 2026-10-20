"""Bounded affine correspondence from structure; never adjusts evaluated colors."""

import numpy as np
from PIL import Image

IDENTITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])


def features(image, edge):
    h, w = image.shape[:2]
    size = (max(16, round(w * edge / max(h, w))), max(16, round(h * edge / max(h, w))))
    gray = image @ np.array([0.2126, 0.7152, 0.0722])
    gray = np.asarray(
        Image.fromarray(gray.astype(np.float32)).resize(size, Image.Resampling.BOX),
        dtype=np.float64,
    )
    kernel = np.exp(-(np.arange(-12, 13, dtype=float) ** 2) / 18)
    kernel /= kernel.sum()

    def blur(values):
        for axis in (0, 1):
            padding = [(0, 0), (0, 0)]
            padding[axis] = (12, 12)
            windows = np.lib.stride_tricks.sliding_window_view(
                np.pad(values, padding, mode="reflect"), 25, axis=axis
            )
            values = np.einsum("ijk,k->ij", windows, kernel, optimize=False)
        return values

    mean = blur(gray)
    return (gray - mean) / np.sqrt(
        np.maximum(blur(gray * gray) - mean * mean, 0) + 1e-4
    )


def sample(image, px, py):
    h, w = image.shape
    if np.any(px < 1) or np.any(py < 1) or np.any(px > w - 2) or np.any(py > h - 2):
        return None
    x, y = np.floor(px).astype(int), np.floor(py).astype(int)
    fx, fy = px - x, py - y
    a, b, c, d = image[y, x], image[y, x + 1], image[y + 1, x], image[y + 1, x + 1]
    value = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return value, (b - a) * (1 - fy) + (d - c) * fy, (c - a) * (1 - fx) + (d - b) * fx


def stage(source, target, warp):
    h, w = target.shape
    yy, xx = np.mgrid[
        round(h * 0.1) : h - round(h * 0.1), round(w * 0.1) : w - round(w * 0.1)
    ]
    xx, yy = xx.ravel(), yy.ravel()
    xn, yn = (xx - (w - 1) / 2) / w, (yy - (h - 1) / 2) / h
    a, b, tx, c, d, ty = warp.ravel()
    params = np.array(
        [
            (a - 1) * w,
            b * w,
            w * (tx + 0.5 * (a + b - 1)),
            c * h,
            (d - 1) * h,
            h * (ty + 0.5 * (c + d - 1)),
            1.0,
            0.0,
        ]
    )
    target_values = target[yy, xx]

    def evaluate(p):
        sampled = sample(
            source, xx + p[0] * xn + p[1] * yn + p[2], yy + p[3] * xn + p[4] * yn + p[5]
        )
        if sampled is None:
            return None
        values, gx, gy = sampled
        error = p[6] * values + p[7] - target_values
        return values, gx, gy, error, float(np.mean(error * error))

    for iteration in range(80):
        measured = evaluate(params)
        if measured is None:
            raise ValueError("registration exceeds structural matching support")
        values, gx, gy, error, cost = measured
        jac = np.column_stack(
            [
                params[6] * gx * xn,
                params[6] * gx * yn,
                params[6] * gx,
                params[6] * gy * xn,
                params[6] * gy * yn,
                params[6] * gy,
                values,
                np.ones(len(xx)),
            ]
        )
        normal = jac.T @ jac
        delta = np.linalg.solve(
            normal + np.diag(1e-4 * (np.diag(normal) + 1e-8)), -jac.T @ error
        )
        accepted = False
        for fraction in (1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125):
            trial = params + fraction * delta
            if (
                np.max(np.abs(trial[:3] / w)) > 0.1
                or np.max(np.abs(trial[3:6] / h)) > 0.1
            ):
                continue
            if not 0.25 < trial[6] < 4:
                continue
            tested = evaluate(trial)
            if tested is not None and tested[-1] < cost:
                params, accepted = trial, True
                break
        if not accepted or np.max(np.abs(fraction * delta[:6])) < 1e-4:
            break
    values = evaluate(params)[0]
    correlation = float(np.corrcoef(values, target_values)[0, 1])
    a, b, c, d = 1 + params[0] / w, params[1] / w, params[3] / h, 1 + params[4] / h
    result = np.array(
        [
            [a, b, params[2] / w - 0.5 * (a + b - 1)],
            [c, d, params[5] / h - 0.5 * (c + d - 1)],
        ]
    )
    return result, {
        "edge": max(h, w),
        "correlation": correlation,
        "iterations": iteration + 1,
    }


def estimate(candidate, reference):
    if (
        candidate.shape != reference.shape
        or not np.isfinite(candidate).all()
        or not np.isfinite(reference).all()
    ):
        raise ValueError("invalid registration inputs")
    if np.array_equal(candidate, reference):
        return IDENTITY.copy(), []
    warp, levels = IDENTITY.copy(), []
    for edge in sorted(
        {min(edge, max(candidate.shape[:2])) for edge in (128, 256, 512)}
    ):
        warp, measured = stage(
            features(reference, edge), features(candidate, edge), warp
        )
        levels.append(measured)
    if not all(np.isfinite(row["correlation"]) for row in levels):
        raise ValueError("no measurable structural correspondence")
    if levels[0]["correlation"] < 0.8 or levels[-1]["correlation"] < 0.6:
        raise ValueError("insufficient structural correspondence")
    return warp, levels
