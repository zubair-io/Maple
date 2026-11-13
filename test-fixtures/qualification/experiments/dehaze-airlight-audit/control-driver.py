from pathlib import Path
import subprocess,json,os,hashlib
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');root=r/'dehaze-airlight-audit'
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
manifest=json.loads((r/'branch36-full-suite/source/test-fixtures/manifest.json').read_text());case=next(c for c in manifest['cases'] if c['name']=='test_0015/dehaze_max')
known={x['path']:x['sha256'] for x in map(json.loads,(r/'branch36-full-suite/inputs-before.jsonl').read_text().splitlines())};paths=[case[k] for k in ['raw','xmp','acr_xmp'] if k in case];assert all(sha(Path(p))==known[p] for p in paths)
job=root/'source35-fcs-test_0015_dehaze_max';job.mkdir(exist_ok=False);shard=job/'manifest.json';shard.write_text(json.dumps({'cases':[case]})+'\n')
env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(MAPLE_DEHAZE_AUDIT='1',RAYON_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
with (job/'render.log').open('w') as log:subprocess.run([str(root/'maple-cli-source35-fcs'),'batch','--manifest',str(shard),'--out-dir',str(job/'candidates'),'--profile','neutral','--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
rows=[json.loads(l.split('DEHAZE_AUDIT ',1)[1]) for l in (job/'render.log').read_text().splitlines() if 'DEHAZE_AUDIT ' in l];assert rows
old=r/'nlm-gaussian-tail-pilot/candidates/test_0015_dehaze_max.png';out=job/'candidates/test_0015_dehaze_max.png';same=sha(old)==sha(out)
assert all(sha(Path(p))==known[p] for p in paths)
result={'fixture':'test_0015/dehaze_max','rows':rows,'pixel_output_sha256':sha(out),'frozen_tail_candidate_output_sha256':sha(old),'diagnostic_output_matches_frozen':same,'inputs_unchanged':True,'interpretation':'Instrumentation only; fractional-tie A hypothetical, not adopted. Exact output match needed before causal conclusions.'};(root/'control-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
assert not same
