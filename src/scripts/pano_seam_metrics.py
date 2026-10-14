"""Owner-map seam-step metrics for the pano harness (split from pano_metrics
for the file-size budget). Pure numpy; see pano_metrics for the harness."""
from __future__ import annotations

import numpy as np
from PIL import Image


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


def load_owner(owner_path, size) -> np.ndarray:
    with Image.open(owner_path) as im:
        arr = np.asarray(im)
    if arr.ndim == 3:
        arr = arr[..., 0]
    owner = arr.astype(np.int64) - 1
    if (owner.shape[1], owner.shape[0]) != size:
        im2 = Image.fromarray(
            (np.clip(owner + 1, 0, 65535)).astype(np.uint16), mode="I;16")
        im2 = im2.resize(size, Image.NEAREST)
        owner = np.asarray(im2).astype(np.int64) - 1
    return owner



def seam_step_checks(check) -> None:
    syn = np.full((120, 200, 3), 0.4, dtype=np.float32)
    syn[:, 100:, :] = 0.4 * np.exp(0.25)
    syn_owner = np.zeros((120, 200), dtype=np.int64)
    syn_owner[:, 100:] = 1
    s_step = seam_step(syn, syn_owner)
    check("seam-step-detects",
          s_step["seam_step_hard"] is not None
          and s_step["seam_step_hard"] > 0.15,
          f"seam_step_hard={s_step['seam_step_hard']} (> 0.15 planted)")
    s_flat = seam_step(syn, np.zeros((120, 200), dtype=np.int64))
    check("seam-step-flat",
          s_flat["seam_step_hard"] is None
          or abs(s_flat["seam_step_hard"]) < 0.02,
          f"seam_step_hard={s_flat['seam_step_hard']} (single owner)")
