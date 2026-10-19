from pathlib import Path
import subprocess,os,json,hashlib,sys,time
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');p=r/'main-local-hr-pilot';base=r/'baseline-cf62d12ddc';scripts=base/'source/src/scripts';manifest=json.loads((r/'branch36-full-suite/source/test-fixtures/manifest.json').read_text());lookup={c['name']:c for c in manifest['cases']};known={e['path']:e['sha256'] for e in map(json.loads,(r/'branch36-full-suite/inputs-before.jsonl').read_text().splitlines())}
def sha(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
identity=json.loads((p/'identity.json').read_text());assert sha(p/'maple-cli')==identity['binary_sha256'];assert sha(base/'source/test-fixtures/budgets.json')=='8a0427c569486b27c9c6cd3bfa5797bb031fa8c0a71d62fa29a9289bfcf17e58'
keys=[('test_0000/sharpen_detail_max','neutral'),('test_0000/exposure_min','neutral'),('test_0000/shadows_min','neutral'),('test_0002/baseline','auto'),('test_0003/baseline','auto'),('test_0007/baseline','auto'),('test_0001/exposure_min','neutral'),('test_0018/temperature_max','neutral')];checked={}
for name,profile in keys:
 c=lookup[name]
 for path in [c[k] for k in ['raw','xmp','acr_xmp'] if k in c]+[o['png'] for o in c['outputs'] if Path(o['png']).exists()]:
  assert path in known and sha(path)==known[path],path;checked[path]=known[path]
env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1');harness=(scripts/'test_color_pipeline.sh').read_text();jobs=p/'physical-anchors';jobs.mkdir(exist_ok=False);results=[]
for name,profile in keys:
 c=lookup[name];job=jobs/(name.replace('/','_')+'-'+profile);job.mkdir();shard=job/'manifest.json';shard.write_text(json.dumps({'cases':[c]})+'\n');out=p/('auto_candidates' if profile=='auto' else 'candidates');out.mkdir(exist_ok=True);start=time.perf_counter()
 with (job/'render.log').open('w') as log:subprocess.run([str(p/'maple-cli'),'batch','--manifest',str(shard),'--out-dir',str(out),'--profile',profile,'--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 render_seconds=time.perf_counter()-start;marker='PY_AUTO' if profile=='auto' else 'PY_DETAIL' if name.split('/')[1].startswith(('sharpen','nr_')) else 'PY';body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];summary=job/'summary.jsonl'
 with (job/'comparison.log').open('w') as log:result=subprocess.run([sys.executable,'-',str(shard),str(out),str(scripts/'compare_images.py'),'full' if marker=='PY_DETAIL' else 'down','',str(base/'source/test-fixtures/budgets.json'),'','','12','_auto' if profile=='auto' else ''],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=log,stderr=subprocess.STDOUT)
 assert result.returncode in(0,1);d=json.loads(summary.read_text());assert d['compared']==1 and d['errors']==0;results.append(d);(p/'physical-anchor-results.json').write_text(json.dumps(results,indent=2)+'\n');row=d['cases'][0];print('ANCHOR',len(results),name,profile,row['status'],'max',row['max'],'render_s',round(render_seconds,3),flush=True)

assert all(sha(path)==digest for path,digest in checked.items()) and sha(p/'maple-cli')==identity['binary_sha256']
rows=[d['cases'][0] for d in results];key=lambda d:(d['fixture'],d['case'],d['profile']);old={key(d):d for d in json.loads((base/'case-ledger.json').read_text())};assert len(rows)==8
decision={'status':'Captured-main plus local highlight matching only;8physical component controls, no shipping adoption or whole-suite count.','comparisons':len(rows),'failed':sum(d['status']=='breach' for d in rows),'cleared_captured_main':['/'.join(key(d)) for d in rows if d['status']=='passed' and old[key(d)]['status']=='breach'],'new_captured_main':['/'.join(key(d)) for d in rows if d['status']=='breach' and old[key(d)]['status']=='passed'],'all_original_inputs_unchanged':True,'renderer_unchanged':True,'production_changed':False};(p/'physical-anchor-decision.json').write_text(json.dumps(decision,indent=2)+'\n');print(json.dumps(decision),flush=True)
