from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import os,json,subprocess,sys,hashlib
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');root=r/'native-prefix-nlm-pilot';base=r/'baseline-cf62d12ddc';parent=r/'branch37-full-suite';scripts=base/'source/src/scripts'
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
frozen=json.loads((root/'identity.json').read_text());assert sha(root/'maple-cli')==frozen['binary_sha256'];assert sha(base/'source/test-fixtures/budgets.json')=='8a0427c569486b27c9c6cd3bfa5797bb031fa8c0a71d62fa29a9289bfcf17e58'
lookup={c['name']:c for c in json.loads((parent/'source/test-fixtures/manifest.json').read_text())['cases']};names={c['name'] for c in json.loads((r/'fcs-measured-floor-pilot/focused-manifest.json').read_text())['cases']}|{'test_0015/dehaze_max','test_0001/temperature_max'};cases=[lookup[name] for name in sorted(names)];assert len(cases)==73
tasks=[(c,'neutral') for c in cases]+[(c,'auto') for c in cases if c['name'].endswith('/baseline')];assert len(tasks)==93
expected={(c['name'],'auto' if profile=='auto' else 'neutral') for c,profile in tasks}
known={e['path']:e['sha256'] for e in map(json.loads,(parent/'inputs-before.jsonl').read_text().splitlines())};checked={}
for c in cases:
 for p in [c[k] for k in ['raw','xmp','acr_xmp'] if k in c]+[o['png'] for o in c['outputs'] if Path(o['png']).exists()]:assert sha(p)==known[p],p;checked[p]=known[p]
(root/'focused-inputs-before.json').write_text(json.dumps(checked,indent=2)+'\n')
results=json.loads((root/'physical-anchor-results.json').read_text());assert len(results)==7 and all(d['breaches']==0 for d in results)
def task_key(row):return (row['fixture']+'/'+(row['case'].removesuffix('_auto') if row['profile']=='auto' else row['case']),'auto' if row['profile']=='auto' else 'neutral')
reused={task_key(d['cases'][0]) for d in results};assert len(reused)==7 and reused<=expected
jobs=root/'focused-jobs';jobs.mkdir(exist_ok=False);harness=(scripts/'test_color_pipeline.sh').read_text();env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1');progress={'launcher_pid':os.getpid(),'planned':93,'reused_same_frozen_renderer':7,'new_render_tasks':86,'completed':7,'phase':'remaining17Auto baselines','original_inputs':len(checked),'binary_sha256':frozen['binary_sha256']}
def save():
 (root/'focused-results.json').write_text(json.dumps(results,indent=2)+'\n');(root/'focused-progress.json').write_text(json.dumps(progress,indent=2)+'\n')
save()
def job(item):
 c,profile=item;name=c['name'].replace('/','_')+'-'+profile;j=jobs/name;j.mkdir();manifest=j/'manifest.json';manifest.write_text(json.dumps({'cases':[c]})+'\n');folder=root/('auto_candidates' if profile=='auto' else 'candidates');folder.mkdir(exist_ok=True)
 with (j/'render.log').open('w') as f:subprocess.run([str(root/'maple-cli'),'batch','--manifest',str(manifest),'--out-dir',str(folder),'--profile',profile,'--no-bundled-lens'],env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
 marker='PY_AUTO' if profile=='auto' else 'PY_DETAIL' if c['name'].split('/')[1].startswith(('nr_','sharpen')) else 'PY';body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];summary=j/'summary.jsonl'
 with (j/'comparison.log').open('w') as f:res=subprocess.run([sys.executable,'-',str(manifest),str(folder),str(scripts/'compare_images.py'),'full' if marker=='PY_DETAIL' else 'down','',str(base/'source/test-fixtures/budgets.json'),'','','12','_auto' if profile=='auto' else ''],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=f,stderr=subprocess.STDOUT)
 assert res.returncode in(0,1);d=json.loads(summary.read_text());assert d['compared']==1 and d['errors']==0;return name,d
remaining=[item for item in tasks if (item[0]['name'],item[1]) not in reused]
for phase,selected in [('remaining17Auto baselines',[i for i in remaining if i[1]=='auto']),('neutral and native regression controls',[i for i in remaining if i[1]=='neutral'])]:
 progress['phase']=phase;save()
 with ThreadPoolExecutor(max_workers=2) as pool:
  for f in as_completed([pool.submit(job,item) for item in selected]):
   name,d=f.result();results.append(d);progress['completed']=len(results);save();print(len(results),'/93',name,d['cases'][0]['status'],flush=True)
 if phase.startswith('remaining'):
  auto=[d['cases'][0] for d in results if d['cases'][0]['profile']=='auto'];assert len(auto)==20
  if any(row['status']!='passed' for row in auto):progress['phase']='rejected: Auto regression; no neutral expansion';save();raise SystemExit(1)
rows=[d['cases'][0] for d in results];assert {task_key(row) for row in rows}==expected and len(rows)==93
assert all(sha(p)==h for p,h in checked.items()) and sha(root/'maple-cli')==frozen['binary_sha256']
key=lambda row:(row['fixture'],row['case'],row['profile']);old36={key(row):row for row in json.loads((r/'branch36-full-suite/case-ledger.json').read_text())};oldmain={key(row):row for row in json.loads((base/'case-ledger.json').read_text())}
def delta(old):return {'cleared':['/'.join(key(row)) for row in rows if old[key(row)]['status']=='breach' and row['status']=='passed'],'new':['/'.join(key(row)) for row in rows if old[key(row)]['status']=='passed' and row['status']=='breach']}
decision={'status':'Complete93case focused control; no production adoption or whole-suite count claim.','comparisons':93,'failures':sum(row['status']=='breach' for row in rows),'auto_compared':20,'auto_failures':0,'original_inputs_unchanged':True,'binary_unchanged':True,'matched_source36':delta(old36),'matched_captured_main':delta(oldmain)}
if (parent/'case-ledger.json').is_file() and json.loads((parent/'identity.json').read_text())['phase']=='complete':decision['matched_source37']=delta({key(row):row for row in json.loads((parent/'case-ledger.json').read_text())})
else:decision['matched_source37']='pending complete parent37 ledger; do not rerender'
(root/'focused-case-ledger.json').write_text(json.dumps(rows,indent=2)+'\n');(root/'focused-decision.json').write_text(json.dumps(decision,indent=2)+'\n');progress['phase']='complete';save();print(json.dumps(decision),flush=True)
