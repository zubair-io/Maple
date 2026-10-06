"""Render each experimental patch through existing RAW grade harness."""

import json
import subprocess
import time
from pathlib import Path

import numpy as np
from common import CASES, METHODS, MODELS, ROOT, digest, load, write_json
from PIL import Image

probe = ROOT / "removal-scene-probe"
assert (
    digest(probe) == json.loads((ROOT / "probe-build.json").read_text())["binarySha256"]
)
all_methods = METHODS + ["vae-control"]
while True:
    complete = 0
    for case in CASES:
        for model in MODELS:
            parent, meta, source, cov, protected, _, _ = load(case, model)
            folder = parent / model
            for method in all_methods:
                if not (folder / f"{method}.json").exists():
                    continue
                out = folder / f"{method}-grades"
                if (out / "verification.json").exists():
                    complete += 1
                    continue
                context = Path(meta["folder"]).parent / "context"
                if not (out / "report.json").exists():
                    with (folder / f"{method}-bake.log").open("w") as log:
                        subprocess.run(
                            [
                                str(probe),
                                "bake",
                                meta["raw"],
                                str(context),
                                str(folder / f"{method}-prediction-chw.f32"),
                                str(out),
                            ],
                            stdout=log,
                            stderr=subprocess.STDOUT,
                            check=True,
                        )
                checks = []
                for path in sorted(out.glob("*-removal.png")):
                    original = np.asarray(
                        Image.open(
                            path.with_name(path.name.replace("-removal", "-truth"))
                        )
                    )
                    result = np.asarray(Image.open(path))
                    assert original.shape == result.shape == source.shape
                    if method == "bilinear":
                        previous = (
                            Path(meta["folder"])
                            / f"{model}-expanded-grades"
                            / path.name
                        )
                        assert np.array_equal(
                            result, np.asarray(Image.open(previous))
                        ), "Rebuilt harness changed the frozen baseline: " + str(path)
                    changed = np.any(original != result, axis=2)
                    assert (
                        not changed[cov == 0].any() and not changed[protected].any()
                    ), path
                    checks.append(
                        {"grade": path.name, "outsideChanged": 0, "protectedChanged": 0}
                    )
                assert len(checks) == 18
                write_json(out / "verification.json", checks)
                complete += 1
                print(
                    json.dumps(
                        {"baked": f"{case}/{model}/{method}", "gradeChecks": 18}
                    ),
                    flush=True,
                )
    write_json(
        ROOT / "bake-progress.json",
        {"completedSets": complete, "totalSets": 24, "checks": complete * 18},
    )
    if complete == 24:
        break
    time.sleep(3)
print("ALL 432 RAW GRADE PRESERVATION CHECKS PASSED", flush=True)
