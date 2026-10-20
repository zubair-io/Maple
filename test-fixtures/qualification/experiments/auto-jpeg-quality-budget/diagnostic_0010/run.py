from pathlib import Path
import os,json,subprocess
r=Path(__file__).resolve().parent;identity=json.loads((r/"identity.json").read_text())
env={k:v for k,v in os.environ.items() if not k.startswith("MAPLE_")}
env.update(MAPLE_STAGE_DUMP=str(r/"diagnostic"),MAPLE_STAGE_DUMP_ROI="0,0,1,1",RAYON_NUM_THREADS="4")
with (r/"render.log").open("w") as log:
 p=subprocess.run([identity["binary"],"render",identity["raw"],"--profile","auto","--out",str(r/"auto.png")],env=env,stdout=log,stderr=subprocess.STDOUT,check=False)
raise SystemExit(p.returncode)
