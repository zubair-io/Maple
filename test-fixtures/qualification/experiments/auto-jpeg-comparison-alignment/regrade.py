import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "source"))
import auto_profile_match as gate

root = Path(__file__).resolve().parent
source = root.parent / "auto-jpeg-quality-budget/full-suite"
old = json.loads((source / "summary.json").read_text())
rows = []
for case in old["cases"]:
    folder = source / case["fixture"]
    start = time.monotonic()
    if case["status"] == "no-preview":
        import numpy as np
        from PIL import Image

        with (
            Image.open(folder / "fallback-auto.png") as a,
            Image.open(folder / "fallback-neutral.png") as b,
        ):
            assert a.size == b.size and a.mode == b.mode == "RGB"
            for y in range(0, a.height, 64):
                box = (0, y, a.width, min(y + 64, a.height))
                assert np.array_equal(np.asarray(a.crop(box)), np.asarray(b.crop(box)))
        result = {"status": "no-preview", "fallback_reverified": True}
    else:
        result = gate.compare(folder / "auto.png", folder / "embedded.png", 0.05)
        for file, field in [
            ("auto.png", "auto_sha256"),
            ("embedded.png", "reference_sha256"),
        ]:
            digest = gate.sha(folder / file)
            if field in case:
                assert digest == case[field]
            result[field] = digest
    row = {"fixture": case["fixture"], "seconds": time.monotonic() - start, **result}
    rows.append(row)
    (root / "regrade.json").write_text(
        json.dumps(
            {
                "type": "frozen physical-output regrade; no rerender or color change",
                "source": str(source),
                "binary_sha256": gate.sha(source.parent / "maple-cli"),
                "cases": rows,
                "complete": len(rows) == 20,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "fixture": case["fixture"],
                "status": row["status"],
                "seconds": row["seconds"],
                "native": row.get("native_absolute", {}).get("status"),
            }
        ),
        flush=True,
    )
