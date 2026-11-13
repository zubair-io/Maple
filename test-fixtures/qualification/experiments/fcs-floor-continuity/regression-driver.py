from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import json,subprocess,hashlib,os,sys
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');root=r/'fcs-floor-continuity-pilot';parent=r/'branch37-full-suite';base=r/'baseline-cf62d12ddc';scripts=base/'source/src/scripts'
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
identity=json.loads((root/'identity.json').read_text());assert sha(root/'maple-cli')==identity['binary_sha256']
lookup={c['name']:c for c in json.loads((parent/'source/test-fixtures/manifest.json').read_text())['cases']};known={e['path']:e['sha256'] for e in map(json.loads,(parent/'inputs-before.jsonl').read_text().splitlines())};names=sorted(set(json.loads((r/'branch36-full-suite/matched-original-delta.json').read_text())['new_failures'])-{'test_0015/dehaze_max','test_0001/temperature_max'});assert len(names)==16
checked={}
for name in names:
 c=lookup[name]
 for path in [c[k] for k in ['raw','xmp','acr_xmp'] if k in c]+[o['png'] for o in c['outputs'] if Path(o['png']).exists()]:assert sha(path)==known[path],path;checked[path]=known[path]
jobs=root/'regression-jobs';jobs.mkdir(exist_ok=False);env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1');harness=(scripts/'test_color_pipeline.sh').read_text()
def compare(c,folder,job,label):
 marker='PY_DETAIL' if c['name'].split('/')[1].startswith(('nr_','sharpen')) else 'PY';body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];summary=job/(label+'.jsonl')
 with (job/(label+'.log')).open('w') as log:res=subprocess.run([sys.executable,'-',str(job/'manifest.json'),str(folder),str(scripts/'compare_images.py'),'full' if marker=='PY_DETAIL' else 'down','',str(base/'source/test-fixtures/budgets.json'),'','','12',''],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=log,stderr=subprocess.STDOUT)
 assert res.returncode in (0,1);d=json.loads(summary.read_text());assert d['compared']==1 and d['errors']==0;return d['cases'][0]
def job(name):
 c=lookup[name];j=jobs/name.replace('/','_');j.mkdir();(j/'manifest.json').write_text(json.dumps({'cases':[c]})+'\n');out=root/'candidates'
 with (j/'render.log').open('w') as log:subprocess.run([str(root/'maple-cli'),'batch','--manifest',str(j/'manifest.json'),'--out-dir',str(out),'--profile','neutral','--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 row=compare(c,out,j,'candidate');p=parent/'workspace/candidates'/(name.replace('/','_')+'.png');receipted={}
 for f in (parent/'render-workers').glob('*.receipt.json'):
  try:receipt=json.loads(f.read_text())
  except json.JSONDecodeError:continue
  for e in receipt['outputs']:receipted[e['path']]=e['sha256']
 before=None;parent_hash=receipted.get(str(p))
 if parent_hash:
  assert sha(p)==parent_hash;before=compare(c,parent/'workspace/candidates',j,'parent37');assert sha(p)==parent_hash
 return {'name':name,'after':row,'before_source37':before,'parent_png_sha256':parent_hash,'candidate_png_sha256':sha(out/(name.replace('/','_')+'.png')),'parent_status':'matched completed render receipt' if before else 'not yet receipted; join completed full37 later'}
results=[]
with ThreadPoolExecutor(max_workers=2) as pool:
 for f in as_completed([pool.submit(job,name) for name in names]):
  result=f.result();results.append(result);(root/'regression-results.json').write_text(json.dumps(results,indent=2)+'\n');before=result['before_source37'];print(len(results),'/16',result['name'],'before',before['status'] if before else 'pending','after',result['after']['status'],flush=True)
assert all(sha(p)==h for p,h in checked.items()) and sha(root/'maple-cli')==identity['binary_sha256']
matched=[x for x in results if x['before_source37']];decision={'comparisons':len(results),'failed':sum(x['after']['status']=='breach' for x in results),'matched_source37':len(matched),'cleared_source37':[x['name'] for x in matched if x['before_source37']['status']=='breach' and x['after']['status']=='passed'],'new_source37':[x['name'] for x in matched if x['before_source37']['status']=='passed' and x['after']['status']=='breach'],'unmatched':[x['name'] for x in results if not x['before_source37']],'original_inputs_unchanged':True,'production_adopted':False};(root/'regression-decision.json').write_text(json.dumps(decision,indent=2)+'\n');print(json.dumps(decision),flush=True)
