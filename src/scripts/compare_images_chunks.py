"""Bound temporary Lab/Delta-E arrays without sampling the compared pixels."""

import colour
import numpy as np

BLOCK_PIXELS = 262_144


def perceptual_difference(candidate, reference, lab, retain_lab):
    """Use the caller's canonical Lab conversion and preserve global reduction order.

    Every pixel gets a float64 Delta-E value. Keeping that array means percentile,
    mean, maximum and ROI reductions remain identical to the unchunked comparator.
    Optional zone/hue reports retain their full Lab arrays; ordinary qualification
    does not need them after each block has been compared.
    """
    shape = candidate.shape
    pixels = shape[0] * shape[1]
    cand = candidate.reshape(-1, 3)
    ref = reference.reshape(-1, 3)
    delta = np.empty(pixels, dtype=np.float64)
    cand_lab = np.empty((pixels, 3), dtype=np.float64) if retain_lab else None
    ref_lab = np.empty((pixels, 3), dtype=np.float64) if retain_lab else None
    for start in range(0, pixels, BLOCK_PIXELS):
        end = min(start + BLOCK_PIXELS, pixels)
        a = lab(cand[start:end])
        b = lab(ref[start:end])
        delta[start:end] = colour.delta_E(a, b, method="CIE 2000")
        if retain_lab:
            cand_lab[start:end] = a
            ref_lab[start:end] = b
    return (
        delta.reshape(shape[:2]),
        cand_lab.reshape(shape) if retain_lab else None,
        ref_lab.reshape(shape) if retain_lab else None,
    )
