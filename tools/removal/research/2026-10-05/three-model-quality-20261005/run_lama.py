import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
import torch
from common import ROOT, save_result
from export_lama_native import load_generator
from PIL import Image

cache = ROOT.parent
if len(sys.argv) > 1:
    ROOT = Path(sys.argv[1])
torch.set_num_threads(4)
t = time.perf_counter()
model = load_generator(
    cache / "lama-source-20261004",
    cache / "lama-weights-20261004/big-lama/models/best.ckpt",
    cache / "lama-weights-20261004/big-lama/config.yaml",
).requires_grad_(False)
load = time.perf_counter() - t
for i in range(1, 6):
    for side in [512, 768, 1024]:
        p = ROOT / f"case-{i}" / str(side)
        if (p / "lama.json").exists():
            continue
        rgb = np.asarray(Image.open(p / "source.png")).astype("float32") / 255
        hole = np.asarray(Image.open(p / "hole.png")) > 0
        inputs = np.concatenate(
            [rgb.transpose(2, 0, 1) * (1 - hole)[None], hole[None]], axis=0
        ).astype("float32")[None]
        t = time.perf_counter()
        with torch.inference_mode():
            pred = model(torch.from_numpy(inputs)).numpy()[0].transpose(1, 2, 0)
        report = {
            "model": "Big-LaMa pinned original checkpoint",
            "case": i,
            "inferenceSeconds": time.perf_counter() - t,
            "loadSeconds": load,
            "peakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "precision": "float32",
            "device": "CPU",
            "steps": 1,
            "input": "camera JPEG, fixed native FOV, Lanczos resize",
            "gradientEnabled": False,
        }
        save_result(p, "lama", pred, report)
        print(json.dumps(report), flush=True)
print("DONE", flush=True)
