import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).parent


def resized_float(a, size):
    return np.stack(
        [
            np.asarray(
                Image.fromarray(a[:, :, k]).resize(
                    (size, size), Image.Resampling.BILINEAR
                )
            )
            for k in range(3)
        ],
        axis=-1,
    ).astype("float32")


def save_result(folder, label, pred, report):
    source = np.asarray(Image.open(folder / "source.png").convert("RGB"))
    assert pred.shape == source.shape and np.isfinite(pred).all()
    pred = np.clip(pred, 0, 1).astype("float32")
    pred.tofile(folder / f"{label}-prediction.f32")
    coverage = np.fromfile(folder / "coverage.f32", dtype="<f4").reshape(
        source.shape[:2]
    )
    out = (
        np.floor(
            (
                source.astype("float32") / 255 * (1 - coverage[:, :, None])
                + pred * coverage[:, :, None]
            )
            * 255
            + 0.5
        )
        .clip(0, 255)
        .astype("uint8")
    )
    assert np.array_equal(out[coverage == 0], source[coverage == 0])
    Image.fromarray(out).save(folder / f"{label}.png")
    Image.fromarray(np.floor(pred * 255 + 0.5).astype("uint8")).save(
        folder / f"{label}-uncomposited.png"
    )
    parent = folder.parent
    src = np.asarray(Image.open(parent / "source-native.png"))
    n = src.shape[0]
    cov = np.fromfile(parent / "coverage-native.f32", dtype="<f4").reshape(n, n)
    native = (
        src.astype("float32") / 255 * (1 - cov[:, :, None])
        + resized_float(pred, n) * cov[:, :, None]
    )
    native_u8 = np.floor(native * 255 + 0.5).clip(0, 255).astype("uint8")
    assert np.array_equal(native_u8[cov == 0], src[cov == 0])
    Image.fromarray(native_u8).save(folder / f"{label}-native.png")
    Image.fromarray(native_u8).resize((512, 512), Image.Resampling.LANCZOS).save(
        folder / f"{label}-review.png"
    )
    report.update(
        nativeSide=n,
        modelSide=source.shape[0],
        outsideCoverageChangedPixels=0,
        releaseQualified=False,
        nativeDetailReconstructed=False,
    )
    (folder / f"{label}.json").write_text(json.dumps(report, indent=2))
