"""#3941: exact native model-RGB inputs and selected-only composites."""

import hashlib

import numpy as np
from PIL import Image

PIXEL_BUDGET = 1800000


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def native_context(image_path, mask_path, crop):
    with Image.open(image_path) as image, Image.open(mask_path) as mask:
        source = np.asarray(image.convert("RGB"))
        values = np.asarray(mask)
    if values.shape != source.shape[:2] or not np.isin(values, [0, 255]).all():
        raise ValueError("Expected a matching single-channel binary native mask")
    x, y, width, height = crop
    if (
        min(x, y) < 0
        or min(width, height) < 1024
        or max(width, height) > 2048
        or width * height > PIXEL_BUDGET
        or width % 8
        or height % 8
        or x + width > source.shape[1]
        or y + height > source.shape[0]
    ):
        raise ValueError("Native context must fit the upstream budget without resizing")
    hole = values[y : y + height, x : x + width] == 255
    if not hole.any() or hole.all():
        raise ValueError("Need selected pixels and known native context")
    if np.count_nonzero(values) != np.count_nonzero(hole):
        raise ValueError("The crop must contain the entire selection")
    native = source[y : y + height, x : x + width].copy()
    return native, hole


def save_result(output, name, result, source, hole):
    composite = source.copy()
    composite[hole] = result[hole]
    if not np.isfinite(composite).all() or composite.min() < 0 or composite.max() > 1:
        raise ValueError("Invalid SDR refinement output")
    np.ascontiguousarray(composite, dtype="<f4").tofile(output / f"{name}.f32")
    image_u8 = np.rint(composite * 255).astype(np.uint8)
    Image.fromarray(image_u8).save(output / f"{name}.png")
    return {
        "sha256": digest(output / f"{name}.f32"),
        "outside_float_bits_changed": int(
            np.count_nonzero(
                composite[~hole].view(np.uint32) != source[~hole].view(np.uint32)
            )
        ),
        "outside_u8_samples_changed": int(
            np.count_nonzero(
                image_u8[~hole] != np.rint(source[~hole] * 255).astype(np.uint8)
            )
        ),
    }


def float_source(path, source_u8):
    if path is None:
        return source_u8.astype(np.float32) / np.float32(255)
    # The existing Rust scene probe emits channel-first f32, never a display JPEG.
    height, width = source_u8.shape[:2]
    if path.stat().st_size != height * width * 3 * 4:
        raise ValueError("Float model input differs from native context geometry")
    values = np.fromfile(path, dtype="<f4")
    if values.size != height * width * 3:
        raise ValueError("Float model input differs from native context geometry")
    source = values.reshape(3, height, width).transpose(1, 2, 0).copy()
    if (
        not np.isfinite(source).all()
        or source.min() < 0
        or source.max() > 1
        # Match Rust f32::round for the diagnostic PNG, including positive ties.
        or not np.array_equal(np.floor(source * 255 + 0.5).astype(np.uint8), source_u8)
    ):
        raise ValueError("Float input is invalid or differs from its native proxy")
    return source
