"""Numerical export test against PyTorch for the actual complex FFT seam."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from lama_fft_onnx import RealFFT2, InverseRealFFT2


class FourierRoundTrip(torch.nn.Module):
    def forward(self, image):
        height, width = image.shape[-2:]
        spectrum = RealFFT2.apply(image, int(height), int(width))
        # A nontrivial frequency-space transform exercises complex layout and
        # Hermitian restoration; an identity pair alone could hide both bugs.
        modified = spectrum * 0.75
        return spectrum, InverseRealFFT2.apply(modified, int(height), int(width))


class PortableFourierTests(unittest.TestCase):
    def test_standard_dft_matches_real_fft_for_rectangular_and_square_inputs(self):
        torch.manual_seed(3941)
        model = FourierRoundTrip().eval()
        for height, width in [(8, 16), (32, 32), (128, 256)]:
            with (
                self.subTest(height=height, width=width),
                tempfile.TemporaryDirectory() as directory,
            ):
                image = torch.randn(1, 3, height, width)
                path = Path(directory) / "fft.onnx"
                torch.onnx.export(
                    model,
                    image,
                    str(path),
                    opset_version=17,
                    dynamo=False,
                    input_names=["image"],
                    output_names=["spectrum", "restored"],
                )
                runtime = ort.InferenceSession(
                    str(path), providers=["CPUExecutionProvider"]
                )
                actual = runtime.run(None, {"image": image.numpy()})
                expected = model(image)
                np.testing.assert_allclose(
                    actual[0], expected[0].numpy(), rtol=1e-4, atol=2e-5
                )
                np.testing.assert_allclose(
                    actual[1], (image * 0.75).numpy(), rtol=1e-4, atol=2e-5
                )


if __name__ == "__main__":
    unittest.main()
