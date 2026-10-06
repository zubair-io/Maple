"""Freeze six coarse fills and matched mask/context inputs without overwriting."""

import json
import shutil

from common import BASE, CASES, MODELS, ROOT, digest, write_json

ROOT.mkdir(exist_ok=False)
jobs = json.loads((BASE / "mask-expansion/jobs.json").read_text())
for case in CASES:
    job = next(
        j
        for j in jobs
        if j["mode"] == "raw" and j["case"] == case and j["expansionModelPixels"] == 16
    )
    folder = __import__("pathlib").Path(job["folder"])
    parent = ROOT / f"case-{case}"
    parent.mkdir()
    for original, target in [
        ("source-native.png", "source.png"),
        ("coverage-native.f32", "coverage.f32"),
        ("protected-native.png", "protected.png"),
    ]:
        shutil.copy2(folder.parent / original, parent / target)
    for model in MODELS:
        shutil.copy2(folder / f"{model}-prediction.f32", parent / f"{model}-coarse.f32")
        shutil.copy2(
            folder / f"{model}.json", parent / f"{model}-coarse-provenance.json"
        )
    write_json(
        parent / "input.json",
        job
        | {
            "coarseReview": "Target removed; indoor floor retains tonal/structural defects and is a stress case, not an accepted perfect fill.",
            "frozenInputs": {
                p.name: digest(p) for p in parent.iterdir() if p.is_file()
            },
        },
    )
write_json(
    ROOT / "protocol.json",
    {
        "issue": 3941,
        "cases": CASES,
        "coarseModels": MODELS,
        "methods": [
            "bilinear",
            "RGB-guided native-source PatchMatch",
            "shared-latent tiled low-strength diffusion",
        ],
        "mainOutputs": 18,
        "maskExpansion": 16,
        "modelResolution": 512,
        "newRemovalGeneration": False,
        "rawMode": True,
        "finalCoverage": "Identical frozen expanded native coverage across methods/models",
        "qualityGate": "Review at fit and native resolution, then exposure/WB. Outside-pixel preservation is not fill acceptance.",
        "limitations": [
            "Three scenes only; assistant visual preflight, not blind ground truth",
            "Floor coarse fill retains tonal seam: stress case",
            "Single seed/settings; neither complete published guided PatchMatch nor exact MultiDiffusion reproduction",
            "Common third-party refinement model isolates choice of coarse LaMa/Qwen fill",
            "No performance optimization or production integration",
        ],
    },
)
print(ROOT)
