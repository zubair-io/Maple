import json
import subprocess
import time

import numpy as np
from common import ROOT, resized_float
from PIL import Image

probe = ROOT.parent / "desktop-quality-target/release/examples/removal-scene-probe"
cases = json.loads((ROOT / "raw/cases.json").read_text())
cases = [c for c in cases if c["id"] != 5]
jobs = [
    (c, 512, f"{m}-seed{seed}")
    for m in ["klein", "qwen"]
    for c in cases
    for seed in [0, 1]
]
while jobs:
    progress = False
    for job in jobs[:]:
        c, side, label = job
        p = ROOT / "raw" / f"case-{c['id']}" / str(side)
        out = p / f"{label}-grades"
        n = c["window"][2]
        if (out / "report.json").exists():
            jobs.remove(job)
            continue
        if label == "resize-control":
            pred = np.asarray(Image.open(p / "source.png")).astype("float32") / 255
        else:
            if not (p / f"{label}.json").exists():
                continue
            pred = np.fromfile(p / f"{label}-prediction.f32", dtype="<f4").reshape(
                side, side, 3
            )
        native = p / f"{label}-upsampled-chw.f32"
        resized_float(pred, n).transpose(2, 0, 1).copy().tofile(native)
        with (p / f"{label}-bake.log").open("w") as log:
            subprocess.run(
                [
                    str(probe),
                    "bake",
                    c["raw"],
                    str(p.parent / "context"),
                    str(native),
                    str(out),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
            )
        print(
            json.dumps(
                {"case": c["id"], "side": side, "candidate": label, "grades": 18}
            ),
            flush=True,
        )
        jobs.remove(job)
        progress = True
    if not progress:
        time.sleep(3)
print("ALL BAKES DONE", flush=True)
