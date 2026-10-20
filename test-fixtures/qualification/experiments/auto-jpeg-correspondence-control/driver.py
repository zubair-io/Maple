from pathlib import Path
import os,json,subprocess
r=Path(__file__).resolve().parent
identity=json.loads((r/"identity.json").read_text())
cases={c["fixture"]:c for c in json.loads((r.parent/"auto-embedded-jpeg-source37/summary.json").read_text())["cases"]}
env={k:v for k,v in os.environ.items() if not k.startswith("MAPLE_")};env["RAYON_NUM_THREADS"]="4"
for name in ["test_0017","test_0012"]:
 out=r/name;out.mkdir(exist_ok=False)
 with (out/"render.log").open("w") as log:
  p=subprocess.run([identity["binary"],"render",cases[name]["raw"],"--profile","neutral","--lens","off","--out",str(out/"neutral-lens-off.png")],env=env,stdout=log,stderr=subprocess.STDOUT,check=False)
 assert p.returncode==0,(name,p.returncode)
 print(name,flush=True)
