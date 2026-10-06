"""Local #3941 detail experiment. Does not modify original assets."""

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
CACHE = Path("/Users/riabuz/.cache/maple-removal-research")
BASE = CACHE / "three-model-quality-20261005"
ROOT = BASE / "native-detail-20261006"
MODELS = ["lama", "qwen-seed0"]
CASES = [4, 2, 1]
METHODS = ["bilinear", "patchmatch", "diffusion"]


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def resize(a, n):
    return np.stack(
        [
            np.asarray(
                Image.fromarray(a[:, :, k]).resize((n, n), Image.Resampling.BILINEAR)
            )
            for k in range(3)
        ],
        axis=-1,
    ).astype("float32")


def png(path, a):
    Image.fromarray(np.floor(a * 255 + 0.5).clip(0, 255).astype("uint8")).save(path)


def load(case, model):
    parent = ROOT / f"case-{case}"
    meta = json.loads((parent / "input.json").read_text())
    n = meta["nativeSide"]
    source = (
        np.asarray(Image.open(parent / "source.png").convert("RGB")).astype("float32")
        / 255
    )
    cov = np.fromfile(parent / "coverage.f32", dtype="<f4").reshape(n, n)
    protected = np.asarray(Image.open(parent / "protected.png")) > 0
    pred = np.fromfile(parent / f"{model}-coarse.f32", dtype="<f4").reshape(512, 512, 3)
    native = resize(pred, n)
    guide = source * (1 - cov[:, :, None]) + native * cov[:, :, None]
    return parent, meta, source, cov, protected, native, guide


def save(case, model, method, pred, report):
    parent, meta, src, cov, protect, _, _guide = load(case, model)
    assert pred.shape == src.shape and np.isfinite(pred).all()
    out = src * (1 - cov[:, :, None]) + np.clip(pred, 0, 1) * cov[:, :, None]
    assert np.array_equal(out[cov == 0], src[cov == 0])
    assert np.array_equal(out[protect], src[protect])
    folder = parent / model
    folder.mkdir(exist_ok=True)
    np.ascontiguousarray(pred.transpose(2, 0, 1), dtype="<f4").tofile(
        folder / f"{method}-prediction-chw.f32"
    )
    png(folder / f"{method}.png", out)
    Image.open(folder / f"{method}.png").resize(
        (512, 512), Image.Resampling.LANCZOS
    ).save(folder / f"{method}-review.png")
    report.update(
        case=case,
        coarseModel=model,
        method=method,
        nativeSide=meta["nativeSide"],
        outsideChanged=0,
        protectedChanged=0,
        sourceSha256=digest(parent / "source.png"),
        coverageSha256=digest(parent / "coverage.f32"),
        coarseSha256=digest(parent / f"{model}-coarse.f32"),
        predictionSha256=digest(folder / f"{method}-prediction-chw.f32"),
        releaseQualified=False,
    )
    write_json(folder / f"{method}.json", report)
    print(json.dumps({"complete": f"{case}/{model}/{method}"}), flush=True)
