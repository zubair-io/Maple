import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
import torch
from export_lama_native import load_generator
from PIL import Image

r = Path(__file__).parent
cache = r.parent
i = int(sys.argv[1])
folder = r / f"case-{i}" / (sys.argv[2] if len(sys.argv) > 2 else "maple-sdr")
torch.set_num_threads(4)
t = time.perf_counter()
model = load_generator(
    cache / "lama-source-20261004",
    cache / "lama-weights-20261004/big-lama/models/best.ckpt",
    cache / "lama-weights-20261004/big-lama/config.yaml",
).requires_grad_(False)
load = time.perf_counter() - t
context = json.loads((folder / "context.json").read_text())
side = context["window"]["width"]
rgb = (
    np.fromfile(folder / "input.f32", dtype="<f4")
    .reshape(3, side, side)
    .transpose(1, 2, 0)
)
source = np.round(rgb * 255).clip(0, 255).astype("uint8")
planes = np.fromfile(folder / "masks.f32", dtype="<f4").reshape(2, side, side)
hole = planes[0] > 0
coverage = planes[1]
intent = coverage == 1
protect = np.zeros(hole.shape, dtype=bool)
inputs = np.concatenate(
    [rgb.transpose(2, 0, 1) * (1 - hole)[None], hole[None]], axis=0
).astype(np.float32)[None]
print(
    json.dumps(
        {
            "case": i,
            "shape": list(inputs.shape),
            "status": "inference",
            "loadSeconds": load,
        }
    ),
    flush=True,
)
t = time.perf_counter()
with torch.inference_mode():
    pred = model(torch.from_numpy(inputs)).numpy()[0].transpose(1, 2, 0)
elapsed = time.perf_counter() - t
assert (
    pred.shape == rgb.shape
    and np.isfinite(pred).all()
    and pred.min() >= 0
    and pred.max() <= 1
)
out = rgb * (1 - coverage[:, :, None]) + pred * coverage[:, :, None]
u8 = np.round(out * 255).clip(0, 255).astype("uint8")
assert np.array_equal(u8[coverage == 0], source[coverage == 0])
pred.transpose(2, 0, 1).astype("<f4").tofile(folder / "lama-prediction-chw.f32")
coverage.tofile(folder / "coverage.f32")
Image.fromarray(u8).save(folder / "lama-result.png")
Image.fromarray(np.round(pred * 255).astype("uint8")).save(
    folder / "lama-uncomposited.png"
)
report = {
    "case": i,
    "model": "pinned Big-LaMa, float32 CPU single forward pass",
    "gradientEnabled": False,
    "input": "Maple post-DCP As-Shot scene plate through fixed AgX/sRGB, float32 native crop, no resizing",
    "dimensions": list(source.shape[:2]),
    "encoding": context["encoding"],
    "modelLoadSeconds": load,
    "inferenceSeconds": elapsed,
    "processPeakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    "selectedPixels": int(intent.sum()),
    "holePixels": int(hole.sum()),
    "outsideCoverageChangedPixels": int(
        np.any(u8 != source, axis=2)[coverage == 0].sum()
    ),
    "protectedChangedPixels": int(np.any(u8 != source, axis=2)[protect].sum()),
    "releaseQualified": False,
    "rawDevelopQualified": False,
}
(folder / "lama-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report), flush=True)
