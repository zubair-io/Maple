import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

r = Path(__file__).parent
probe = r.parent / "desktop-quality-target/release/examples/removal-scene-probe"
raws = {
    14: "/Users/riabuz/Desktop/test/Canon - EOS 5DS R - RAW (3_2).CR2",
    12: "/Users/riabuz/Desktop/test/084A0070.CR2",
}
for i in [14, 12]:
    p = r / f"case-{i}"
    context = Path(json.loads((p / "context-reference.json").read_text())["path"])
    side = json.loads((context / "context.json").read_text())["window"]["width"]
    for candidate in ["moebius-seed0", "moebius-seed1", "lama", "resize-control"]:
        if candidate == "lama":
            values = (
                np.fromfile(p / "lama-prediction-hwc.f32", dtype="<f4")
                .reshape(512, 512, 3)
                .transpose(2, 0, 1)
            )
        else:
            values = np.fromfile(
                p
                / (
                    "input.f32" if candidate == "resize-control" else candidate + ".f32"
                ),
                dtype="<f4",
            ).reshape(3, 512, 512)
        upsampled = np.stack(
            [
                np.array(
                    Image.fromarray(c).resize((side, side), Image.Resampling.BILINEAR)
                )
                for c in values
            ]
        ).clip(0, 1)
        native = p / (candidate + "-upsampled.f32")
        upsampled.tofile(native)
        folder = p / (candidate + "-grades")
        with (p / (candidate + "-bake.log")).open("w") as log:
            subprocess.run(
                [str(probe), "bake", raws[i], str(context), str(native), str(folder)],
                check=True,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        print(
            json.dumps(
                {
                    "case": i,
                    "candidate": candidate,
                    "grades": 18,
                    "sourceSide": side,
                    "modelSide": 512,
                    "detailReconstruction": "Bilinear upsample only, not native-detail restoration",
                }
            ),
            flush=True,
        )
