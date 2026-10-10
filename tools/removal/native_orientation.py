"""#3941: call shared Rust pixel permutation, with exact inverse guards."""

import json
import subprocess

import numpy as np


def orient(probe, source, orientation, directory, name, inverse=False):
    if source.ndim != 3 or source.shape[2] != 3 or source.dtype != np.float32:
        raise ValueError("Expected interleaved native RGB f32")
    height, width = source.shape[:2]
    before = directory / f"{name}-input.f32"
    after = directory / f"{name}-output.f32"
    if before.exists() or after.exists():
        raise ValueError("Choose fresh orientation artifacts")
    source.astype("<f4").tofile(before)
    command = [
        str(probe),
        str(before),
        str(width),
        str(height),
        str(orientation),
        str(after),
    ]
    if inverse:
        command.append("--inverse")
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    row = json.loads(completed.stdout)
    result = np.fromfile(after, dtype="<f4")
    if result.size != height * width * 3:
        raise ValueError("Shared orientation changed the sample count")
    return result.reshape(row["height"], row["width"], 3), row


def exact_roundtrip(probe, source, orientation, directory, name):
    result, forward = orient(probe, source, orientation, directory, name)
    restored, inverse = orient(
        probe, result, orientation, directory, name + "-inverse", inverse=True
    )
    if restored.shape != source.shape or not np.array_equal(
        restored.view(np.uint32), source.view(np.uint32)
    ):
        raise ValueError("Shared orientation inverse changed native sample bits")
    return result, {
        "forward": forward,
        "inverse": inverse,
        "roundtrip_bits_exact": True,
    }
