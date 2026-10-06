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
for i in [32]:
    for model in ["moebius-seed0", "lama", "resize-control"]:
        p = r / f"case-{i}" / (model + "-grades")
        report = json.loads((p / "report.json").read_text())
        coverage = np.array(Image.open(p / "coverage.png")) > 0
        files = sorted(p.glob("*-removal.png"))
        assert len(files) == 18
        for removal in files:
            truth = removal.with_name(removal.name.replace("-removal", "-truth"))
            identity = removal.with_name(removal.name.replace("-removal", "-identity"))
            a = np.array(Image.open(truth))
            b = np.array(Image.open(removal))
            assert a.shape == b.shape
            changed = int(np.any(a != b, axis=2)[~coverage].sum())
            assert changed == 0
            row = {
                "case": i,
                "candidate": model,
                "grade": removal.name.removesuffix("-removal.png"),
                "outsideCoverageChanged": changed,
            }
            # No-edit encode/codec control once per source; resized-original control quantifies resolution loss independently.
            if model == "moebius-seed0":
                row["identityROI"] = diff(
                    str(identity), str(truth), roi_path=str(p / "coverage.png")
                )
            if model == "resize-control":
                row["resizeOnlyROI"] = diff(
                    str(removal), str(truth), roi_path=str(p / "coverage.png")
                )
            rows.append(row)
        print(
            json.dumps({"case": i, "candidate": model, "verifiedGrades": len(files)}),
            flush=True,
        )
        (r / "raw-mask-control-verification.json").write_text(
            json.dumps(rows, indent=2) + "\n"
        )
for i in [1, 2, 3, 4, 5, 12, 14, 21, 22, 23, 24, 32]:
    p = r / f"case-{i}"
    src = np.array(Image.open(p / "source.png"))
    cov = np.fromfile(p / "coverage.f32", dtype="<f4").reshape(512, 512)
    for image in list(p.glob("moebius*seed*.png")) + [p / "lama-result.png"]:
        if "uncomposited" in image.name:
            continue
        out = np.array(Image.open(image))
        assert np.array_equal(src[cov == 0], out[cov == 0])
        if (p / "protected.png").exists():
            protect = np.array(Image.open(p / "protected.png")) > 0
            assert np.array_equal(src[protect], out[protect])
    report = json.loads((p / "lama-report.json").read_text())
    report["selectedPixels"] = int((cov == 1).sum())
    if i in [12, 14, 32]:
        report["input"] = (
            "Maple fixed AgX/sRGB float32 input, bilinear resampled to512; same input as Moebius"
        )
        report["inputReference"] = json.loads(
            (p / "context-reference.json").read_text()
        )
    (p / "lama-report.json").write_text(json.dumps(report, indent=2) + "\n")
originals = json.loads(
    (r.parent / "desktop-quality-9ikrgf16/inventory.json").read_text()
)
checked = [
    {
        "file": Path(x["raw"]).name,
        "unchanged": hashlib.sha256(Path(x["raw"]).read_bytes()).hexdigest()
        == x["sha256"],
    }
    for x in originals
]
assert all(x["unchanged"] for x in checked)
(r / "source-integrity.json").write_text(json.dumps(checked, indent=2) + "\n")
print(
    "All originals unchanged; all recorded output coverage/protection checks passed.",
    flush=True,
)
