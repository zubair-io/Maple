from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
import json,subprocess,os,hashlib,shutil,sys
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');p=r/'nlm-gaussian-tail-pilot';base=r/'baseline-cf62d12ddc';scripts=base/'source/src/scripts';mapping={e['path']:e for e in map(json.loads,(r/'input-snapshot/mapping.jsonl').read_text().splitlines())};original=json.loads((r/'branch31-full-suite/source/test-fixtures/manifest-qualified-companions.json').read_text())
extra=[]
known={e['path']:e['sha256'] for e in map(json.loads,(r/'branch36-full-suite/inputs-before.jsonl').read_text().splitlines())}
checked={}
def snapshot(path):
 q=Path(path);assert path in known,path
 assert hashlib.sha256(q.read_bytes()).hexdigest()==known[path],path
 checked[path]=known[path];return path
cases=[]
delta=json.loads((r/'branch35-full-suite/matched-original-delta.json').read_text());extra_names=set(delta['new_failures']+delta['cleared'])
for c in original['cases']:
 label=c['name'].split('/')[1]
 if label=='baseline':
  c=dict(c);c['raw']=snapshot(c['raw']);c['xmp']=snapshot(c['xmp']);c['outputs']=[o|{'png':snapshot(o['png'])} for o in c['outputs'] if Path(o['png']).exists() or o['png'] in mapping];c.update({'acr_xmp':snapshot(c['acr_xmp'])} if 'acr_xmp' in c else {});cases.append(c)
(p/'extra-inputs.json').write_text(json.dumps(extra,indent=2));(p/'focused-manifest.json').write_text(json.dumps({'cases':cases},indent=2)+'\n');jobs=p/'jobs';jobs.mkdir();shutil.copy2(__file__,p/'focused-driver.py');harness=(scripts/'test_color_pipeline.sh').read_text();env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',PYTHONUNBUFFERED='1')
tasks=[(c,'auto') for c in cases if c['name'] not in ['test_0002/baseline','test_0003/baseline']]
assert len(tasks)==18,len(tasks)
tasks.sort(key=lambda item:(item[0]['name']!='test_0018/contrast_max',item[0]['name'] not in ['test_0007/baseline','test_0009/baseline','test_0001/baseline'],item[1]!='auto',item[0]['name']))

def job(item):
 c,profile=item;name=c['name'].replace('/','_')+'-'+profile;j=jobs/name;j.mkdir();manifest=j/'manifest.json';manifest.write_text(json.dumps({'cases':[c]}));cand=p/('auto_candidates' if profile=='auto' else 'candidates');cand.mkdir(exist_ok=True)
 with (j/'render.log').open('w') as log:subprocess.run([str(p/'maple-cli'),'batch','--manifest',str(manifest),'--out-dir',str(cand),'--profile',profile,'--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 marker='PY_AUTO' if profile=='auto' else 'PY_DETAIL' if c['name'].split('/')[1].startswith(('sharpen','nr_')) else 'PY';body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];summary=j/'summary.jsonl'
 with (j/'comparison.log').open('w') as log:res=subprocess.run([sys.executable,'-',str(manifest),str(cand),str(scripts/'compare_images.py'),'full' if marker=='PY_DETAIL' else 'down','',str(base/'source/test-fixtures/budgets.json'),'','','12','_auto' if profile=='auto' else ''],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=log,stderr=subprocess.STDOUT)
 assert res.returncode in [0,1],(name,res.returncode);d=json.loads(summary.read_text());assert d['compared']==1 and d['errors']==0,(name,d);return name,d
results=[];invalid=[];recorded=set()
def remember(name,d):
 results.append(d);(p/'auto-baseline-results.json').write_text(json.dumps(results,indent=2));print(len(results),'/18',name,d['breaches'],flush=True)
 if d['breaches']:invalid.append(name)
 return bool(d['breaches'])
with ThreadPoolExecutor(max_workers=4) as pool:
 futures=[pool.submit(job,item) for item in tasks]
 for future in as_completed(futures):
  name,d=future.result();recorded.add(future)
  if remember(name,d):
   for pending in futures:pending.cancel()
   break
for future in futures:
 if future not in recorded and not future.cancelled():
  name,d=future.result();remember(name,d)
(p/'auto-baseline-decision.json').write_text(json.dumps({'comparisons':len(results),'planned_fresh':18,'already_completed_autos':2,'new_failures_vs_source36':invalid,'production_changed':False},indent=2)+'\n')
assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest for path,digest in checked.items())
print('Additional Auto baselines',len(results),'cases',sum(d['breaches'] for d in results),'breaches',flush=True)
raise SystemExit(1 if invalid else 0)
