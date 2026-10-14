"""Owner-map seam-step metrics for the pano harness (split from pano_metrics
for the file-size budget). Pure numpy; see pano_metrics for the harness."""
from __future__ import annotations

import numpy as np


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def _box_blur(arr: np.ndarray, radius: int) -> np.ndarray:
    if radius < 1:
        return arr.copy()
    out = arr.astype(np.float64)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode="edge")
        csum = np.cumsum(padded, axis=axis)
        csum = np.concatenate(
            [np.zeros_like(np.take(csum, [0], axis=axis)), csum], axis=axis)
        n = 2 * radius + 1
        hi = np.take(csum, np.arange(n, csum.shape[axis]), axis=axis)
        lo = np.take(csum, np.arange(0, csum.shape[axis] - n), axis=axis)
        out = (hi - lo) / n
    return out


def _gaussian_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    out = arr.astype(np.float64)
    for _ in range(3):
        out = _box_blur(out, max(1, int(round(sigma))))
    return out


def seam_step(cand: np.ndarray, owner: np.ndarray,
              sigma: float = 32.0) -> dict:
    log_luma = np.log(np.maximum(_luma(cand), 1e-4)).astype(np.float64)
    valid = owner >= 0

    def step_of(field: np.ndarray) -> tuple:
        dh = np.abs(field[:, 1:] - field[:, :-1])
        bh = valid[:, 1:] & valid[:, :-1] & (owner[:, 1:] != owner[:, :-1])
        dv = np.abs(field[1:, :] - field[:-1, :])
        bv = valid[1:, :] & valid[:-1, :] & (owner[1:, :] != owner[:-1, :])
        seam_vals = np.concatenate([dh[bh], dv[bv]]) if (bh.any() or bv.any()) \
            else np.zeros(0)
        ctrl_vals = np.concatenate([dh[valid[:, 1:] & valid[:, :-1] & ~bh],
                                    dv[valid[1:, :] & valid[:-1, :] & ~bv]])
        if seam_vals.size == 0 or ctrl_vals.size == 0:
            return None, None
        return float(seam_vals.mean()), float(ctrl_vals.mean())

    hard, hard_ctrl = step_of(log_luma)
    low, low_ctrl = step_of(_gaussian_blur(log_luma, sigma))
    if hard is None or low is None:
        return {"seam_step_hard": None, "seam_step_lowpass": None,
                "seam_step_hard_raw": None, "seam_step_lowpass_raw": None,
                "seam_step_control": None,
                "seam_step_r": None, "seam_step_g": None, "seam_step_b": None}
    per_channel = {}
    for ci, name in enumerate(("seam_step_r", "seam_step_g", "seam_step_b")):
        field = np.log(np.maximum(cand[..., ci], 1e-4)).astype(np.float64)
        v, vc = step_of(field)
        per_channel[name] = float(v - vc) if v is not None else None
    return {
        "seam_step_hard": float(hard - hard_ctrl),
        "seam_step_lowpass": float(low - low_ctrl),
        "seam_step_hard_raw": float(hard),
        "seam_step_lowpass_raw": float(low),
        "seam_step_control": float(hard_ctrl),
        **per_channel,
    }


