"""#3941: native gradient-preserving boundary correction research.

Independently authored four-neighbor Dirichlet solve, following the equation
in Perez et al., Poisson Image Editing (2003). This corrects boundary colour
drift; it cannot repair generated geometry or qualify photographic texture.
No application/core path uses this Python diagnostic.
"""

import numpy as np
import pyamg
from scipy.sparse import coo_array

PIXEL_BUDGET = 1800000


def correct(source, prediction, domain):
    if (
        source.dtype != np.float32
        or prediction.dtype != np.float32
        or source.shape != prediction.shape
        or source.ndim != 3
        or source.shape[2] != 3
        or domain.dtype != bool
        or domain.shape != source.shape[:2]
        or domain.size > PIXEL_BUDGET
        or not domain.any()
        or not np.isfinite(source).all()
        or not np.isfinite(prediction).all()
        or domain[0].any()
        or domain[-1].any()
        or domain[:, 0].any()
        or domain[:, -1].any()
    ):
        raise ValueError("Expected finite native f32 RGB and a bounded interior domain")
    height, width = domain.shape
    y, x = np.nonzero(domain)
    count = len(x)
    ids = np.full((height, width), -1, dtype=np.int32)
    ids[y, x] = np.arange(count, dtype=np.int32)
    index = np.arange(count, dtype=np.int32)
    rows, columns = [index], [index]
    values = [np.full(count, 4.0)]
    rhs = np.zeros((count, 3), dtype=np.float64)
    boundary_residual = source.astype(np.float64) - prediction
    boundary_edges = 0
    for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        neighbor = ids[y + dy, x + dx]
        inside = neighbor >= 0
        rows.append(index[inside])
        columns.append(neighbor[inside])
        values.append(np.full(int(inside.sum()), -1.0))
        known = ~inside
        rhs[known] += boundary_residual[y[known] + dy, x[known] + dx]
        boundary_edges += int(known.sum())
    matrix = coo_array(
        (np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))),
        shape=(count, count),
    ).tocsr()
    solver = pyamg.ruge_stuben_solver(matrix)
    channels, residuals = [], []
    for channel in range(3):
        history = []
        solution = solver.solve(
            rhs[:, channel], tol=1e-8, maxiter=100, accel="cg", residuals=history
        )
        norm = np.linalg.norm(rhs[:, channel])
        residual = np.linalg.norm(matrix @ solution - rhs[:, channel])
        relative = float(residual / norm) if norm else float(residual)
        if not np.isfinite(solution).all() or relative > 1e-6:
            raise ValueError("Native boundary correction did not converge")
        channels.append(solution)
        residuals.append(
            {"relative_residual": relative, "iterations": len(history) - 1}
        )
    correction = np.stack(channels, axis=1)
    result = source.copy()
    result[y, x] = (prediction[y, x].astype(np.float64) + correction).astype(np.float32)
    if not np.isfinite(result).all():
        raise ValueError("Native boundary correction overflowed f32")
    if not np.array_equal(
        result[~domain].view(np.uint32), source[~domain].view(np.uint32)
    ):
        raise ValueError("Native boundary correction changed known source samples")
    return result, {
        "unknown_pixels": count,
        "boundary_edges": boundary_edges,
        "matrix_nonzeros": int(matrix.nnz),
        "solver": "PyAMG classical Ruge-Stuben preconditioned conjugate gradients",
        "channels": residuals,
        "max_absolute_correction": float(np.abs(correction).max()),
        "range": [float(result.min()), float(result.max())],
        "outside_float_bits_changed": 0,
        "source_inside_domain_used_for_rhs": False,
        "clipped": False,
    }
