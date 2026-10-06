"""Independent checks and review sheets; no perceptual pass inferred from metrics."""

import json
import shutil
from pathlib import Path

import numpy as np
from common import BASE, CASES, METHODS, MODELS, REPO, ROOT, digest, load, write_json
from PIL import Image, ImageDraw

rows = []
for case in CASES:
    for model in MODELS:
        parent, meta, source, cov, protected, native, guide = load(case, model)
        for name, h in meta["frozenInputs"].items():
            assert digest(parent / name) == h
        for method in METHODS + ["vae-control"]:
            folder = parent / model
            report = json.loads((folder / f"{method}.json").read_text())
            saved = np.asarray(Image.open(folder / f"{method}.png"))
            expected = np.floor(source * 255 + 0.5).astype("uint8")
            assert np.array_equal(saved[cov == 0], expected[cov == 0])
            assert np.array_equal(saved[protected], expected[protected])
            if method == "bilinear":
                prior = np.asarray(
                    Image.open(Path(meta["folder"]) / f"{model}-expanded-native.png")
                )
                assert np.array_equal(saved, prior)
            grades = json.loads(
                (folder / f"{method}-grades/verification.json").read_text()
            )
            assert len(grades) == 18 and all(
                x["outsideChanged"] == x["protectedChanged"] == 0 for x in grades
            )
            row = {
                "case": case,
                "coarseModel": model,
                "method": method,
                "nativeSide": meta["nativeSide"],
                "outsideChanged": 0,
                "protectedChanged": 0,
                "gradeChecks": len(grades),
                "seconds": report.get("seconds"),
                "resultSha256": digest(folder / f"{method}.png"),
            }
            rows.append(row)
originals = []
for case in json.loads((BASE / "cases.json").read_text()):
    actual = digest(case["raw"])
    assert actual == case["sha256"]
    originals.append({"path": case["raw"], "sha256": actual})
review = ROOT / "review"
review.mkdir(exist_ok=True)
for case in CASES:
    for grade in ["auto_ev+0_wb+0", "neutral_ev+3_wb+1000"]:
        sheet = Image.new("RGB", (1536, 1070), "white")
        draw = ImageDraw.Draw(sheet)
        for row, model in enumerate(MODELS):
            for col, method in enumerate(METHODS):
                path = (
                    ROOT
                    / f"case-{case}"
                    / model
                    / f"{method}-grades/{grade}-removal.png"
                )
                im = Image.open(path)
                im.thumbnail((512, 512))
                sheet.paste(im, (512 * col, 535 * row + 23))
                draw.text(
                    (512 * col + 8, 535 * row + 5), model + " | " + method, fill="black"
                )
        sheet.save(review / f"case-{case}-{grade}.jpg", quality=94)
write_json(
    ROOT / "summary.json",
    {
        "mainOutputs": 18,
        "vaeControls": 6,
        "rawGradeChecks": sum(x["gradeChecks"] for x in rows),
        "frozenInputsUnchanged": True,
        "baselinePlateAndAllRawGradesPixelIdentical": True,
        "originalsUnchanged": originals,
        "results": rows,
        "releaseQualified": False,
    },
)
harness = ROOT / "executed-harness"
harness.mkdir(exist_ok=True)
for p in (REPO / "tools/removal/research/2026-10-06").glob("*.py"):
    shutil.copy2(p, harness / p.name)
print(
    "VERIFIED: 18 outputs + 6 controls; 432 RAW preservation checks; frozen inputs and all 5 originals unchanged."
)
