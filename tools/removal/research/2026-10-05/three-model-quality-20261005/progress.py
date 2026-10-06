import json
import time
from pathlib import Path

r = Path(__file__).parent
while True:
    counts = {}
    for mode, root in [("photo", r), ("raw", r / "raw")]:
        for model in ["lama", "klein", "qwen"]:
            files = [
                p
                for p in root.glob(f"case-*/*/{model}*.json")
                if p.name in ["lama.json", f"{model}-seed0.json", f"{model}-seed1.json"]
            ]
            counts[mode + "-" + model] = len(files)
    bakes = len(list((r / "raw").glob("case-*/*/*-grades/report.json")))
    text = f"Completed generation: photographic {counts['photo-lama']}/15 LaMa, {counts['photo-klein']}/20 Klein, {counts['photo-qwen']}/10 Qwen; RAW input {counts['raw-lama']}/15 LaMa, {counts['raw-klein']}/20 Klein, {counts['raw-qwen']}/10 Qwen. RAW grade sets: {bakes}/48. Kiss M RAW develop checks unavailable (missing calibration)."
    (r / "progress.json").write_text(
        json.dumps({"text": text, "counts": counts, "bakes": bakes}, indent=2)
    )
    if (
        all(
            counts[f"{m}-{k}"] == n
            for m in ["photo", "raw"]
            for k, n in [("lama", 15), ("klein", 20), ("qwen", 10)]
        )
        and bakes == 48
    ):
        break
    time.sleep(5)
