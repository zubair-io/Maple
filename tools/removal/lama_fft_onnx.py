"""LaMa's orthonormal real FFT pair as standard ONNX DFT operators (#3941).

The exporter keeps complex numbers as a final [real, imaginary] dimension,
avoiding custom runtime operators. This module is qualification tooling.
"""

import math

import torch
from torch.onnx.symbolic_helper import parse_args


def constant(graph, values, dtype=torch.int64):
    return graph.op("Constant", value_t=torch.tensor(values, dtype=dtype))


class RealFFT2(torch.autograd.Function):
    @staticmethod
    def forward(context, image, height, width):
        return torch.view_as_real(torch.fft.rfftn(image, dim=(-2, -1), norm="ortho"))

    @staticmethod
    @parse_args("v", "i", "i")
    def symbolic(graph, image, height, width):
        real = graph.op("Unsqueeze", image, constant(graph, [-1]))
        columns = graph.op("DFT", real, axis_i=3, inverse_i=0, onesided_i=1)
        rows = graph.op("DFT", columns, axis_i=2, inverse_i=0, onesided_i=0)
        return graph.op(
            "Mul", rows, constant(graph, [1 / math.sqrt(height * width)], torch.float32)
        )


class InverseRealFFT2(torch.autograd.Function):
    @staticmethod
    def forward(context, packed, height, width):
        return torch.fft.irfftn(
            torch.view_as_complex(packed.contiguous()),
            s=(height, width),
            dim=(-2, -1),
            norm="ortho",
        )

    @staticmethod
    @parse_args("v", "i", "i")
    def symbolic(graph, packed, height, width):
        rows = graph.op("DFT", packed, axis_i=2, inverse_i=1, onesided_i=0)
        # After reversing the height transform, each row is an ordinary
        # one-sided real FFT. Complete its Hermitian spectrum without DC or
        # the Nyquist endpoint, then invert the width transform.
        reflected = graph.op(
            "Slice",
            rows,
            constant(graph, [-2]),
            constant(graph, [0]),
            constant(graph, [3]),
            constant(graph, [-1]),
        )
        conjugated = graph.op(
            "Mul", reflected, constant(graph, [1.0, -1.0], torch.float32)
        )
        full = graph.op("Concat", rows, conjugated, axis_i=3)
        columns = graph.op("DFT", full, axis_i=3, inverse_i=1, onesided_i=0)
        real = graph.op("Gather", columns, constant(graph, 0), axis_i=4)
        return graph.op(
            "Mul", real, constant(graph, [math.sqrt(height * width)], torch.float32)
        )


def portable_fourier_forward(unit, image):
    if (
        unit.ffc3d
        or unit.spatial_scale_factor is not None
        or unit.spectral_pos_encoding
        or unit.use_se
        or unit.fft_norm != "ortho"
    ):
        raise ValueError("Pinned LaMa Fourier unit uses an unsupported configuration")
    batch, _, height, width = image.shape
    packed = RealFFT2.apply(image, int(height), int(width))
    spectral = (
        packed.permute(0, 1, 4, 2, 3)
        .contiguous()
        .reshape(batch, -1, height, width // 2 + 1)
    )
    spectral = unit.relu(unit.bn(unit.conv_layer(spectral)))
    packed = (
        spectral.reshape(batch, -1, 2, height, width // 2 + 1)
        .permute(0, 1, 3, 4, 2)
        .contiguous()
    )
    return InverseRealFFT2.apply(packed, int(height), int(width))
