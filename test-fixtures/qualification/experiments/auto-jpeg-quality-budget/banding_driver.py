from pathlib import Path
import os,sys,json,subprocess
r=Path(__file__).resolve().parent
repo=Path("/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple")
raw=next(row["raw"] for row in json.loads((r.parent/"auto-embedded-jpeg-source37/summary.json").read_text())["cases"] if row["fixture"]=="test_0000")
env={k:v for k,v in os.environ.items() if not k.startswith("MAPLE_")};env["RAYON_NUM_THREADS"]="4"
with (r/"banding-producer.log").open("w") as log:
 proc=subprocess.run([str(r/"maple-cli"),"auto-tail-ramp","--raw",raw,"--out-dir",str(r/"banding")],env=env,check=False,stdout=log,stderr=subprocess.STDOUT)
assert proc.returncode==0,proc.returncode
rows=[]
for ramp in ["neutral","foliage","blue","magenta","skin"]:
 axis="luma" if ramp=="neutral" else "chroma"
 with (r/("banding-"+ramp+".log")).open("w") as log:
  proc=subprocess.run([sys.executable,str(repo/"src/scripts/banding_check.py"),str(r/"banding"/ramp),"--stage","18_auto_tail","--ramp-axis",axis,"--json",str(r/("banding-"+ramp+".json")),"--budgets",str(repo/"test-fixtures/banding_budgets.json"),"--budget-key",f"test_0000_auto2_{ramp}/18_auto_tail/{axis}","--require-budget"],env=env,check=False,stdout=log,stderr=subprocess.STDOUT)
 rows.append({"ramp":ramp,"exit":proc.returncode});print(rows[-1],flush=True)
(r/"banding-results.json").write_text(json.dumps(rows,indent=2)+"\n")
raise SystemExit(0 if all(row["exit"]==0 for row in rows) else 1)
