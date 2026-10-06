import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np
from common import ROOT, resized_float
from PIL import Image

BASE = ROOT.parent
CACHE = BASE.parent
probe = CACHE / "desktop-quality-target/release/examples/removal-scene-probe"
jobs = json.loads((ROOT / "jobs.json").read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()


def check_grades(out, protection):
    cov = np.asarray(Image.open(out / "coverage.png")) > 0
    rows = []
    for p in sorted(out.glob("*-removal.png")):
        a = np.asarray(Image.open(p.with_name(p.name.replace("-removal", "-truth"))))
        b = np.asarray(Image.open(p))
        identity = np.asarray(
            Image.open(p.with_name(p.name.replace("-removal", "-identity")))
        )
        outside = int(np.any(a != b, axis=2)[~cov].sum())
        protected = int(np.any(a != b, axis=2)[protection].sum())
        unchanged = int(np.any(a != identity, axis=2)[~cov].sum())
        assert outside == protected == unchanged == 0
        rows.append(
            {
                "grade": p.name.removesuffix("-removal.png"),
                "outsideCoverageChangedPixels": outside,
                "protectedChangedPixels": protected,
            }
        )
    assert len(rows) == 18
    (out / "verification.json").write_text(json.dumps(rows, indent=2))


while True:
    complete = 0
    bakes = 0
    verifications = 0
    for job in jobs:
        p = Path(job["folder"])
        n = job["nativeSide"]
        src = np.asarray(Image.open(p.parent / "source-native.png"))
        protected = np.asarray(Image.open(p.parent / "protected-native.png")) > 0
        for model in ["lama", f"qwen-seed{job['seed']}"]:
            report = p / f"{model}.json"
            if not report.exists():
                continue
            complete += 1
            if sha(p / "source.png") != job["baselineInputSha256"]:
                raise RuntimeError("Input changed")
            pred = np.fromfile(p / f"{model}-prediction.f32", dtype="<f4").reshape(
                512, 512, 3
            )
            assert np.isfinite(pred).all()
            native = resized_float(pred, n)
            if not (p / f"{model}-verification.json").exists():
                checks = []
                for coverage_name in ["expanded", "original"]:
                    covfile = p.parent / (
                        "coverage-native.f32"
                        if coverage_name == "expanded"
                        else "coverage-original-native.f32"
                    )
                    cov = np.fromfile(covfile, dtype="<f4").reshape(n, n)
                    out = (
                        np.floor(
                            (
                                src.astype("float32") / 255 * (1 - cov[:, :, None])
                                + native * cov[:, :, None]
                            )
                            * 255
                            + 0.5
                        )
                        .clip(0, 255)
                        .astype("uint8")
                    )
                    assert np.array_equal(out[cov == 0], src[cov == 0])
                    assert np.array_equal(out[protected], src[protected])
                    Image.fromarray(out).save(p / f"{model}-{coverage_name}-native.png")
                    Image.fromarray(out).resize(
                        (512, 512), Image.Resampling.LANCZOS
                    ).save(p / f"{model}-{coverage_name}-review.png")
                    checks.append(
                        {
                            "coverage": coverage_name,
                            "outsideChanged": 0,
                            "protectedChanged": 0,
                        }
                    )
                (p / f"{model}-verification.json").write_text(
                    json.dumps(
                        {
                            "inputSha256": sha(p / "source.png"),
                            "holeSha256": sha(p / "hole.png"),
                            "predictionSha256": sha(p / f"{model}-prediction.f32"),
                            "finite": True,
                            "checks": checks,
                        },
                        indent=2,
                    )
                )
            verifications += 1
            if job["mode"] == "raw" and job["case"] != 5:
                nativefile = p / f"{model}-upsampled-chw.f32"
                if not nativefile.exists():
                    native.transpose(2, 0, 1).copy().tofile(nativefile)
                for coverage_name in ["expanded", "original"]:
                    out = p / f"{model}-{coverage_name}-grades"
                    ctx = (
                        p.parent / "context"
                        if coverage_name == "expanded"
                        else Path(job["baselineContext"])
                    )
                    if not (out / "report.json").exists():
                        with (p / f"{model}-{coverage_name}-bake.log").open("w") as log:
                            subprocess.run(
                                [
                                    str(probe),
                                    "bake",
                                    job["raw"],
                                    str(ctx),
                                    str(nativefile),
                                    str(out),
                                ],
                                stdout=log,
                                stderr=subprocess.STDOUT,
                                check=True,
                            )
                    if not (out / "verification.json").exists():
                        check_grades(out, protected)
                    bakes += 1
        del src, protected
    progress = {
        "completedGenerations": complete,
        "totalGenerations": 24,
        "verifiedGenerations": verifications,
        "rawGradeSets": bakes,
        "totalRawGradeSets": 32,
        "text": f"{complete}/24 expanded-mask generations; {bakes}/32 RAW grade sets checked. Baselines retained from the previous experiment.",
    }
    tmp = ROOT / "progress.tmp"
    tmp.write_text(json.dumps(progress, indent=2))
    tmp.replace(ROOT / "progress.json")
    if complete == 24 and bakes == 32:
        break
    time.sleep(3)
checks = []
for c in json.loads((BASE / "cases.json").read_text()):
    h = sha(Path(c["raw"]))
    assert h == c["sha256"]
    checks.append({"file": Path(c["raw"]).name, "sha256": h, "unchanged": True})
(ROOT / "source-integrity.json").write_text(json.dumps(checks, indent=2))
print(
    "ALL 24 GENERATIONS AND 576 RAW GRADE CHECKS VERIFIED; ORIGINALS UNCHANGED",
    flush=True,
)
