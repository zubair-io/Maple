"""#3941: remove selected source detail from one native inference condition.

The original canonical RAW/model context stays immutable. A harmonic fill
uses only the known four-neighbor boundary, with zero interior gradients.
This is a conditioning experiment, not accepted reconstruction or app policy.
"""

import numpy as np
from native_seam_correction import correct


def erase(source, hole):
    if (
        source.dtype != np.float32
        or hole.dtype != bool
        or not np.isfinite(source).all()
        or source.min() < 0
        or source.max() > 1
    ):
        raise ValueError("Expected finite native model RGB and binary hole")
    # With zero prediction/gradients, the existing Dirichlet operator's RHS
    # reads source only at known boundary pixels. No selected pixel enters it.
    result, solver = correct(source, np.zeros_like(source), hole)
    if result.min() < 0 or result.max() > 1:
        raise ValueError("Erased conditioning left the model domain; never clip it")
    if not np.array_equal(result[~hole].view(np.uint32), source[~hole].view(np.uint32)):
        raise ValueError("Erased conditioning changed known source samples")
    return result, {
        "method": "native-harmonic-known-boundary-v1",
        "selected_source_samples_used": False,
        "selected_pixels": int(hole.sum()),
        "changed_selected_samples": int(np.count_nonzero(result[hole] != source[hole])),
        "known_source_bits_changed": 0,
        "resampled": False,
        "clipped": False,
        "range": [float(result.min()), float(result.max())],
        "solver": solver,
        "scope": "Inference conditioning only. No original, canonical anchor, coverage, protection or accepted output is changed.",
    }
