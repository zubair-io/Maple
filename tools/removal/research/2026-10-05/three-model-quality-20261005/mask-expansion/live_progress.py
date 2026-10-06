import json
import time
from pathlib import Path

r = Path(__file__).parent
jobs = json.loads((r / "jobs.json").read_text())
last = None
while True:
    count = sum(
        (Path(j["folder"]) / f"{m}.json").exists()
        for j in jobs
        for m in ["lama", f"qwen-seed{j['seed']}"]
    )
    grades = len(list(r.glob("raw/case-*/expand-*/512/*-grades/verification.json")))
    data = {
        "completedGenerations": count,
        "totalGenerations": 24,
        "rawGradeSets": grades,
        "totalRawGradeSets": 32,
        "text": f"{count}/24 expanded-mask generations complete; {grades}/32 RAW grade sets verified. Original-mask baselines retained.",
    }
    tmp = r / "live-progress.tmp"
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(r / "live-progress.json")
    if (count, grades) != last:
        print(data["text"], flush=True)
        last = (count, grades)
    if count == 24 and grades == 32:
        break
    time.sleep(5)
