"""#3941: exact PowerPaint conditioning and actual VAE boundary evidence."""

import numpy as np
import torch
from native_probe_pixels import digest
from PIL import Image


def conditioning(source, hole, processor, float_input):
    height, width = hole.shape
    masked = source.copy()
    masked[hole] = 0
    image = (
        torch.from_numpy(masked.transpose(2, 0, 1)[None].copy())
        if float_input
        else Image.fromarray(np.floor(masked * 255 + 0.5).astype(np.uint8))
    )
    mask = Image.fromarray(hole.astype(np.uint8) * 255).convert("RGB")
    expected = torch.from_numpy((masked * 2 - 1).transpose(2, 0, 1)[None].copy())
    prepared = processor.preprocess(image, height=height, width=width)
    prepared_mask = processor.preprocess(mask, height=height, width=width)
    expected_mask = torch.from_numpy(
        np.repeat((hole.astype(np.float32) * 2 - 1)[None, None], 3, axis=1)
    )
    if not torch.equal(prepared, expected) or not torch.equal(
        prepared_mask, expected_mask
    ):
        raise ValueError("Pipeline preprocessing changed native source or mask samples")
    return image, mask, expected, masked


def raw_candidate(output, source, hole):
    height, width = hole.shape
    decoder = np.fromfile(output / "decoder-model-nchw.f32", dtype="<f4")
    if decoder.size != height * width * 3 or not np.isfinite(decoder).all():
        raise ValueError("Invalid actual native decoder evidence")
    prediction = decoder.reshape(3, height, width).transpose(1, 2, 0)
    candidate = source.copy()
    candidate[hole] = prediction[hole]
    path = output / "raw-candidate-nchw.f32"
    candidate.transpose(2, 0, 1).copy().astype("<f4").tofile(path)
    return {
        "sha256": digest(path),
        "generation_out_of_model_range_samples": int(
            np.count_nonzero((candidate[hole] < 0) | (candidate[hole] > 1))
        ),
        "outside_float_bits_changed": int(
            np.count_nonzero(
                candidate[~hole].view(np.uint32) != source[~hole].view(np.uint32)
            )
        ),
        "clamped": False,
        "scope": "Unclamped decoder samples inside generation hole; exact source elsewhere. Canonical RAW inverse must independently validate this file.",
    }


class VaeBoundaries:
    def __init__(self, expected, output):
        self.expected = expected
        self.output = output
        self.encoded = []
        self.decoded = []

    def encode(self, module, arguments):
        actual = arguments[0].detach().cpu()
        # The pinned upstream duplicates image conditioning for CFG before encode.
        expected = self.expected.repeat(2, 1, 1, 1)
        if actual.dtype != torch.float32 or not torch.equal(actual, expected):
            raise ValueError("Actual VAE input changed native float source samples")
        path = self.output / "vae-input-normalized-nchw.f32"
        actual.numpy().astype("<f4").tofile(path)
        self.encoded.append(
            {"shape": list(actual.shape), "samples_equal": True, "sha256": digest(path)}
        )

    def decode(self, module, arguments, result):
        height, width = self.expected.shape[-2:]
        if (
            tuple(result.shape) != (1, 3, height, width)
            or result.dtype != torch.float32
            or not torch.isfinite(result).all()
        ):
            raise ValueError("Invalid native pre-clamp decoder output")
        values = result.detach().cpu().numpy()
        path = self.output / "decoder-normalized-nchw.f32"
        values.astype("<f4").tofile(path)
        model_rgb = values / np.float32(2) + np.float32(0.5)
        model_path = self.output / "decoder-model-nchw.f32"
        model_rgb.astype("<f4").tofile(model_path)
        self.decoded.append(
            {
                "shape": list(result.shape),
                "finite": True,
                "minimum": float(values.min()),
                "maximum": float(values.max()),
                "normalized_sha256": digest(path),
                "model_sha256": digest(model_path),
                "out_of_model_range_samples": int(
                    np.count_nonzero((model_rgb < 0) | (model_rgb > 1))
                ),
                "clamped": False,
            }
        )

    def verify_complete(self, steps, requested_steps):
        if len(self.encoded) != 1 or len(self.decoded) != 1:
            raise ValueError("Missing or repeated actual VAE boundary evidence")
        if [row["index"] for row in steps] != list(range(requested_steps)):
            raise ValueError("Incomplete actual native diffusion steps")
