from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
import json,subprocess,os,hashlib,shutil,sys
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');p=r/'hot-pixel-default-pilot';base=r/'baseline-cf62d12ddc';scripts=base/'source/src/scripts';mapping={e['path']:e for e in map(json.loads,(r/'input-snapshot/mapping.jsonl').read_text().splitlines())};original=json.loads((r/'branch31-full-suite/source/test-fixtures/manifest-qualified-companions.json').read_text())
extra=[]
known={e['path']:e['sha256'] for e in map(json.loads,(r/'branch31-full-suite/inputs-before.jsonl').read_text().splitlines())}
checked={}
def snapshot(path):
 q=Path(path);assert path in known,path
 assert hashlib.sha256(q.read_bytes()).hexdigest()==known[path],path
 checked[path]=known[path];return path
cases=[]
delta=json.loads((r/'branch35-full-suite/matched-original-delta.json').read_text());extra_names=set(delta['new_failures']+delta['cleared'])
for c in original['cases']:
 label=c['name'].split('/')[1]
 if label=='baseline' or (c['name'].startswith('test_0000/') and label.startswith(('nr_','sharpen'))) or c['name'] in ['test_0007/clarity_max','test_0007/texture_max','test_0007/whites_min','test_0002/sharpen_amount_max','test_0002/vibrance_min','test_0002/wb_shade','test_0003/sharpen_detail_min','test_0015/sharpen_amount_max'] or c['name'] in extra_names:
  c=dict(c);c['raw']=snapshot(c['raw']);c['xmp']=snapshot(c['xmp']);c['outputs']=[o|{'png':snapshot(o['png'])} for o in c['outputs'] if Path(o['png']).exists() or o['png'] in mapping];c.update({'acr_xmp':snapshot(c['acr_xmp'])} if 'acr_xmp' in c else {});cases.append(c)
import xml.etree.ElementTree as ET
staged=p/'staged-inputs';staged.mkdir();staged_hashes={};stage_audit=[]
for c in cases:
 original_path=Path(c['xmp']);text=original_path.read_text();assert 'HotPixelSuppression' not in text,c['name']
 prefix=' papp:HotPixelSuppression="On"'
 if 'xmlns:papp=' not in text:prefix=' xmlns:papp="http://ns.justmaple.app/1.0/"'+prefix
 assert text.count('<rdf:Description')==1,c['name']
 changed=text.replace('<rdf:Description','<rdf:Description'+prefix,1)
 parsed=ET.fromstring(changed);removed=0
 for element in parsed.iter():
  for key in list(element.attrib):
   if key.endswith('}HotPixelSuppression'):
    assert element.attrib.pop(key)=='On';removed+=1
 assert removed==1 and ET.tostring(parsed)==ET.tostring(ET.fromstring(text)),c['name']
 # Reuse the exact already-rendered diagnostic for the first target.
 target=(r/'panasonic-exposure-regression/hot-pixel-counterfactual/diagnostic-hot-pixel-on.xmp') if c['name']=='test_0001/exposure_min' else staged/(c['name'].replace('/','_')+'.xmp')
 if c['name']!='test_0001/exposure_min':target.write_text(changed)
 staged_hashes[str(target)]=hashlib.sha256(target.read_bytes()).hexdigest()
 stage_audit.append({'case':c['name'],'original_xmp':str(original_path),'original_sha256':hashlib.sha256(original_path.read_bytes()).hexdigest(),'staged_xmp':str(target),'staged_sha256':staged_hashes[str(target)],'only_added_setting':'HotPixelSuppression On'})
 c['xmp']=str(target)
(p/'staged-input-audit.json').write_text(json.dumps(stage_audit,indent=2)+'\n')
(p/'extra-inputs.json').write_text(json.dumps(extra,indent=2));(p/'focused-manifest.json').write_text(json.dumps({'cases':cases},indent=2)+'\n');jobs=p/'jobs';jobs.mkdir();shutil.copy2(__file__,p/'focused-driver.py');harness=(scripts/'test_color_pipeline.sh').read_text();env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_')};env.update(RAYON_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',PYTHONUNBUFFERED='1')
tasks=[(c,'neutral') for c in cases]+[(c,'auto') for c in cases if c['name'].endswith('/baseline')]
assert len(tasks)==91,len(tasks)
tasks.sort(key=lambda item:(item[0]['name']!='test_0018/contrast_max',item[0]['name'] not in ['test_0007/baseline','test_0009/baseline','test_0001/baseline'],item[1]!='auto',item[0]['name']))

def job(item):
 c,profile=item;name=c['name'].replace('/','_')+'-'+profile;j=jobs/name;j.mkdir();manifest=j/'manifest.json';manifest.write_text(json.dumps({'cases':[c]}));cand=p/('auto_candidates' if profile=='auto' else 'candidates');cand.mkdir(exist_ok=True)
 with (j/'render.log').open('w') as log:subprocess.run([str(p/'maple-cli'),'batch','--manifest',str(manifest),'--out-dir',str(cand),'--profile',profile,'--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
 marker='PY_AUTO' if profile=='auto' else 'PY_DETAIL' if c['name'].split('/')[1].startswith(('sharpen','nr_')) else 'PY';body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];summary=j/'summary.jsonl'
 with (j/'comparison.log').open('w') as log:res=subprocess.run([sys.executable,'-',str(manifest),str(cand),str(scripts/'compare_images.py'),'full' if marker=='PY_DETAIL' else 'down','',str(base/'source/test-fixtures/budgets.json'),'','','12','_auto' if profile=='auto' else ''],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=log,stderr=subprocess.STDOUT)
 assert res.returncode in [0,1],(name,res.returncode);d=json.loads(summary.read_text());assert d['compared']==1 and d['errors']==0,(name,d);return name,d
seed_root=r/'panasonic-exposure-regression/hot-pixel-counterfactual'
seed=json.loads((seed_root/'comparison.jsonl').read_text());assert seed['compared']==1 and seed['breaches']==0 and seed['errors']==0
assert hashlib.sha256((p/'maple-cli').read_bytes()).hexdigest()==hashlib.sha256((r/'branch36-full-suite/maple-cli').read_bytes()).hexdigest()
(p/'candidates').mkdir(exist_ok=True);shutil.copy2(seed_root/'candidates/test_0001_exposure_min.png',p/'candidates/test_0001_exposure_min.png')
results=[seed];(p/'focused-results.json').write_text(json.dumps(results,indent=2));invalid=[]
expected={ (row['fixture'],row['case'],row['profile']):row for result in json.loads((r/'fcs-measured-floor-pilot/focused-results.json').read_text()) for row in result['cases'] }
def remember(name,d):
 results.append(d);(p/'focused-results.json').write_text(json.dumps(results,indent=2));row=d['cases'][0];key=(row['fixture'],row['case'],row['profile']);bad=expected[key]['status']=='passed' and row['status']=='breach'
 print(len(results),'/91',name,d['breaches'],'NEW' if bad else '',flush=True)
 if bad:invalid.append(key)
 return bad
anchors=[next(item for item in tasks if item[0]['name']==name and item[1]=='neutral') for name in ['test_0018/contrast_max','test_0000/nr_luminance_max']]
for item in anchors:
 name,d=job(item)
 if remember(name,d):
  print('Opposing anchor fails under diagnosticOn; stop before broad study.',flush=True)
  assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest for path,digest in checked.items())
  raise SystemExit(1)
remaining=[item for item in tasks if item not in anchors and not (item[0]['name']=='test_0001/exposure_min' and item[1]=='neutral')]
remaining.sort(key=lambda item:(item[1]!='auto',item[0]['name'] not in delta['new_failures'],item[0]['name']))
completed=set()
with ThreadPoolExecutor(max_workers=4) as pool:
 futures=[pool.submit(job,item) for item in remaining]
 for future in as_completed(futures):
  name,d=future.result();completed.add(future)
  if remember(name,d):
   for pending in futures:pending.cancel()
   break
 # Context waits for already-running owned jobs; collect their completed reports below.
for future in futures:
 if future not in completed and not future.cancelled():
  name,d=future.result();remember(name,d)
assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest for path,digest in staged_hashes.items())
(p/'decision.json').write_text(json.dumps({'diagnostic_only':True,'comparisons':len(results),'planned':91,'fresh_rendered':len(results)-1,'reused_verified_control':1,'new_failures_vs_original_conditions':invalid,'original_inputs_revalidated':True,'staged_inputs_unchanged':True,'status':'rejected on observed regressions' if invalid else 'completed diagnostic cohort; no production change'},indent=2)+'\n')
assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest for path,digest in checked.items())
print('Hot-pixel diagnostic cohort',len(results),'cases',sum(d['breaches'] for d in results),'breaches;',len(invalid),'new vs original conditions',flush=True)
raise SystemExit(1 if invalid else 0)
