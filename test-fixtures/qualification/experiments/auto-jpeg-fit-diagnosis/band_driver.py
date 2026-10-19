from pathlib import Path
import hashlib,json,os,subprocess
r=Path(__file__).resolve().parent
rows=json.loads(Path('/Users/riabuz/.codex/color-suite-evidence/5000/auto-embedded-jpeg-source37/summary.json').read_text())['cases']
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
binary=r/'band-probe';binary_sha=sha(binary)
identity={'purpose':'Pair-domain diagnostics, not a physical gate or source change. Separate structured fit, bake approximation and native-pixel averaging.','binary_sha256':binary_sha,'cases':[],'source_sha256':sha('/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/raw-pipeline/raw-core/examples/auto_jpeg_fit_probe.rs')}
env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
for name in ['test_0017','test_0015','test_0012']:
 row=next(x for x in rows if x['fixture']==name);assert sha(row['raw'])==row['raw_sha256']
 out=r/f'{name}-bands.json'
 with (r/f'{name}-bands.log').open('w') as log:proc=subprocess.run([str(binary),row['raw'],str(out)],env=env,stdout=log,stderr=subprocess.STDOUT)
 assert proc.returncode==0,(name,proc.returncode)
 assert sha(row['raw'])==row['raw_sha256'] and sha(binary)==binary_sha
 identity['cases'].append({'fixture':name,'raw_sha256':row['raw_sha256'],'report_sha256':sha(out),'report':out.name})
 (r/'bands-identity.json').write_text(json.dumps(identity,indent=2)+'\n');print(name,'bands complete',flush=True)
identity['complete']=True;(r/'bands-identity.json').write_text(json.dumps(identity,indent=2)+'\n')
