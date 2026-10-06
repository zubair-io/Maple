import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/removal-quality-spike/_Maple/src/scripts"
)
from compare_images import diff

r = Path(__file__).parent
rows = []
for relative in ["case-1/grades", "case-2/grades", "case-2/grades-plus2"]:
    p = r / relative
    mask = np.asarray(Image.open(p / "coverage.png")) > 0
    for candidate in sorted(p.glob("*-identity.png")):
        truth = candidate.with_name(candidate.name.replace("-identity", "-truth"))
        removal = candidate.with_name(candidate.name.replace("-identity", "-removal"))
        a = np.asarray(Image.open(truth))
        b = np.asarray(Image.open(candidate))
        c = np.asarray(Image.open(removal))
        assert a.shape == b.shape == c.shape
        known = int(np.any(a != c, axis=2)[~mask].sum())
        assert known == 0
        row = {
            "case": relative,
            "grade": candidate.name.removesuffix("-identity.png"),
            "knownChangedPixels": known,
            "identityMaxCodeError": int(np.abs(a.astype(int) - b).max()),
            "identityROI": diff(
                str(candidate), str(truth), roi_path=str(p / "coverage.png")
            ),
        }
        rows.append(row)
    (r / "identity-metrics.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(relative, "completed", flush=True)
originals = json.loads((r / "inventory.json").read_text())
checks = [
    {
        "file": Path(x["raw"]).name,
        "unchanged": hashlib.sha256(Path(x["raw"]).read_bytes()).hexdigest()
        == x["sha256"],
    }
    for x in originals
]
assert all(x["unchanged"] for x in checks)
(r / "source-integrity.json").write_text(json.dumps(checks, indent=2) + "\n")
print(
    json.dumps(
        {
            "grades": len(rows),
            "maxMeanIdentityROI": max(x["identityROI"]["mean_deltaE"] for x in rows),
            "maxIdentityCodeError": max(x["identityMaxCodeError"] for x in rows),
            "originals": checks,
        }
    ),
    flush=True,
)
