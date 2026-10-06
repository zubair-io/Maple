import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
jobs = json.loads((ROOT / "jobs.json").read_text())
runs = []
grades = []
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for job in jobs:
    p = Path(job["folder"])
    assert sha(p / "source.png") == job["baselineInputSha256"]
    for model in ["lama", f"qwen-seed{job['seed']}"]:
        r = json.loads((p / f"{model}.json").read_text())
        v = json.loads((p / f"{model}-verification.json").read_text())
        assert v["finite"]
        if model.startswith("qwen"):
            assert r["executedSteps"] == 40
        runs.append(
            {
                "mode": job["mode"],
                "case": job["case"],
                "expansionModelPixels": job["expansionModelPixels"],
                "expansionSourcePixels": job["expansionSourcePixels"],
                "model": model,
                "report": str((p / f"{model}.json").relative_to(ROOT)),
                "reportSha256": sha(p / f"{model}.json"),
                "predictionSha256": sha(p / f"{model}-prediction.f32"),
                "finite": v["finite"],
            }
        )
        if job["mode"] == "raw" and job["case"] != 5:
            for cov in ["expanded", "original"]:
                rows = json.loads(
                    (p / f"{model}-{cov}-grades/verification.json").read_text()
                )
                assert len(rows) == 18
                assert all(
                    x["outsideCoverageChangedPixels"] == 0
                    and x["protectedChangedPixels"] == 0
                    for x in rows
                )
                grades.extend(rows)
assert len(runs) == 24 and len(grades) == 576
composites = json.loads((ROOT / "composite-verification.json").read_text())
assert len(composites) == 48
sources = json.loads((ROOT / "source-integrity.json").read_text())
assert len(sources) == 5 and all(x["unchanged"] for x in sources)
files = [
    "prepare.py",
    "run_lama.py",
    "run_qwen.py",
    "finish_results.py",
    "common.py",
    "finalize_composites.py",
    "jobs.json",
    "protocol.json",
]
result = {
    "experiment": "LaMa + Qwen mask expansion",
    "complete": True,
    "newGenerations": len(runs),
    "displayComposites": len(composites),
    "rawGradePreservationChecks": len(grades),
    "allFinite": True,
    "unchangedOriginals": sources,
    "outsideAndProtectedChanges": 0,
    "protocol": json.loads((ROOT / "protocol.json").read_text()),
    "runs": runs,
    "harnessHashes": {f: sha(ROOT / f) for f in files},
    "rawProbeSha256": sha(
        ROOT.parent.parent
        / "desktop-quality-target/release/examples/removal-scene-probe"
    ),
    "qualification": "Preservation checks are not image-quality acceptance. Case5 lacks calibrated RAW development under #4283. These are 512 model predictions upsampled to source size, not native-resolution detail reconstruction.",
}
(ROOT / "summary.json").write_text(json.dumps(result, indent=2))
print(
    "24 generations, 48 composites, 576 RAW preservation checks, 5 unchanged originals verified"
)
