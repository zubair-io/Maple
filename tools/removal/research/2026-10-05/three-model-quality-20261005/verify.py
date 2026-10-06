import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/removal-quality-spike/_Maple/src/scripts"
)
from common import ROOT
from roi_metrics import roi_diff as diff

r = ROOT
while True:
    folders = list((r / "raw").glob("case-*/*/*-grades"))
    for p in folders:
        if not (p / "report.json").exists() or (p / "verification.json").exists():
            continue
        coverage = np.asarray(Image.open(p / "coverage.png")) > 0
        rows = []
        model = p.name.removesuffix("-grades")
        side = int(p.parent.name)
        files = sorted(p.glob("*-removal.png"))
        assert len(files) == 18
        for removal in files:
            truth = removal.with_name(removal.name.replace("-removal", "-truth"))
            identity = removal.with_name(removal.name.replace("-removal", "-identity"))
            a = np.asarray(Image.open(truth))
            b = np.asarray(Image.open(removal))
            ident = np.asarray(Image.open(identity))
            assert a.shape == b.shape == ident.shape
            outside = int(np.any(a != b, axis=2)[~coverage].sum())
            outside_id = int(np.any(a != ident, axis=2)[~coverage].sum())
            assert outside == outside_id == 0
            row = {
                "grade": removal.name.removesuffix("-removal.png"),
                "outsideCoverageChangedPixels": outside,
            }
            # Full native geometry for every grade; perceptual controls only, never score generated content against the still-present object.
            if model == "resize-control":
                row["resizeOnlyROI"] = diff(
                    str(removal), str(truth), roi_path=str(p / "coverage.png")
                )
            if model == "lama" and side == 512:
                row["identityROI"] = diff(
                    str(identity), str(truth), roi_path=str(p / "coverage.png")
                )
            rows.append(row)
        (p / "verification.json").write_text(
            json.dumps(
                {
                    "case": p.parent.parent.name,
                    "side": side,
                    "candidate": model,
                    "grades": rows,
                },
                indent=2,
            )
        )
        print("Verified", str(p.relative_to(r)), flush=True)
    completed = list((r / "raw").glob("case-*/*/*-grades/verification.json"))
    if len(completed) == 48:
        break
    time.sleep(3)
originals = json.loads((r / "cases.json").read_text())
checks = []
for c in originals:
    checksum = hashlib.sha256(Path(c["raw"]).read_bytes()).hexdigest()
    assert checksum == c["sha256"]
    checks.append({"file": Path(c["raw"]).name, "sha256": checksum, "unchanged": True})
(r / "source-integrity.json").write_text(json.dumps(checks, indent=2))
print("ALL 864 GRADE CHECKS VERIFIED; ORIGINALS UNCHANGED", flush=True)
