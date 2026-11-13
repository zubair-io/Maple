from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,sys
repo=Path('/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple')
r=Path('/Users/riabuz/.codex/color-suite-evidence/5000');base=r/'baseline-cf62d12ddc';root=r/'branch37-full-suite'
assert not subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip(),'Freeze a clean source checkpoint first'
assert subprocess.check_output(['git','branch','--show-current'],cwd=repo,text=True).strip()=='codex/color-suite-progress'
assert 'pub const PIPELINE_OUTPUT_VERSION: u32 = 37;' in (repo/'src/raw-pipeline/raw-core/src/version.rs').read_text()
anchor_names={'test_0018/contrast_max','test_0000/nr_luminance_max'}
anchor_hashes={name:hashlib.sha256((r/'nlm-gaussian-tail-pilot/candidates'/(name.replace('/','_')+'.png')).read_bytes()).hexdigest() for name in anchor_names}
root.mkdir(exist_ok=False);source=root/'source';scripts=source/'src/scripts';shutil.copytree(base/'source/src/scripts',scripts,ignore=shutil.ignore_patterns('__pycache__'))
(source/'test-fixtures').mkdir(parents=True);budgets=source/'test-fixtures/budgets.json';shutil.copy2(base/'source/test-fixtures/budgets.json',budgets)
binary=root/'maple-cli';shutil.copy2(r/'nlm-gaussian-tail-pilot/output37-renderer/maple-cli',binary);shutil.copy2(__file__,root/'driver.py')
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
# Reuse the complete corrected immutable input snapshot. Do not reconstruct
# input paths using a directory-prefix allowlist: that dropped six companion
# links in the earlier controller. Every actually required path is checked.
prior=r/'branch31-full-suite'
working=prior/'source/test-fixtures/manifest-qualified-companions.json'
manifest=source/'test-fixtures/manifest.json';shutil.copy2(working,manifest)
manifest_data=json.loads(manifest.read_text());cases=manifest_data['cases']
original=json.loads((base/'source/test-fixtures/references/manifest.json').read_text())['cases']
assert len(cases)==776 and {c['name'] for c in cases}=={c['name'] for c in original}
inputs=[json.loads(line) for line in (prior/'inputs-before.jsonl').read_text().splitlines()]
known={e['path']:e['sha256'] for e in inputs};assert len(known)==963
logical=[json.loads(line) for line in (prior/'input-map.jsonl').read_text().splitlines()]
shutil.copy2(prior/'input-map.jsonl',root/'input-map.jsonl')
shutil.copy2(prior/'inputs-before.jsonl',root/'inputs-before.jsonl')
missing_tiers=[]
for case in cases:
 for key in ['raw','xmp']+(['acr_xmp'] if 'acr_xmp' in case else []):
  assert case[key] in known and Path(case[key]).is_file(),(case['name'],key,case[key])
 outputs={o['resolution']:o['png'] for o in case['outputs']}
 label=case['name'].split('/',1)[1]
 native=label.startswith(('sharpen','nr_'))
 required={'full'} if native else {'down'}
 if label=='baseline' or case.get('reference_protocol')=='native-pair-lanczos-v1':required|={'down','full'}
 if native and 'down' not in outputs:missing_tiers.append({'case':case['name'],'resolution':'down','reason':'not listed in captured manifest; covered by native detail comparison'})
 for resolution in required:assert resolution in outputs and outputs[resolution] in known and Path(outputs[resolution]).is_file(),(case['name'],resolution)
 for resolution,path in outputs.items():
  if Path(path).exists():assert path in known,(case['name'],resolution,path)
  else:
   assert native and resolution=='down',(case['name'],'unexpected absent input',resolution)
   missing_tiers.append({'case':case['name'],'resolution':resolution,'path':path})
assert len(missing_tiers)==170
for e in inputs:assert sha(e['path'])==e['sha256'],e['path']
(root/'input-preflight.json').write_text(json.dumps({'physical_inputs_verified':len(inputs),'allowed_absent_detail_down_tiers':missing_tiers,'manifest_sha256':sha(manifest),'complete':True},indent=2)+'\n')
trace=json.loads((r/'nlm-gaussian-tail-pilot/output37-renderer/identity.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==trace['commit']
assert sha(binary)==trace['binary_sha256'] and trace['pipeline_output_version']==37 and trace['auto_fit_model_version']==7
identity={'phase':'parallel rendering','launcher_pid':os.getpid(),'branch_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'captured_main_commit':'cf62d12ddc573cff68780e7754f7b5b63f7ae621','renderer_tree':subprocess.check_output(['git','rev-parse','HEAD:src/raw-pipeline'],cwd=repo,text=True).strip(),'pipeline_output_version':37,'binary_sha256':sha(binary),'manifest_sha256':sha(manifest),'working_manifest_sha256':sha(working),'budgets_sha256':sha(budgets),'harness_sha256':sha(scripts/'test_color_pipeline.sh'),'comparator_sha256':sha(scripts/'compare_images.py'),'driver_sha256':sha(__file__),'logical_input_paths':len({e['original'] for e in logical}),'physical_input_files':len(inputs),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'render_workers':4,'comparison_workers':8,'completed_render_tasks':0,'render_errors':[],'completed_comparison_tasks':0}
assert identity['budgets_sha256']==json.loads((base/'identity.json').read_text())['budgets_sha256']
def save():(root/'identity.json').write_text(json.dumps(identity,indent=2)+'\n')
identity.update(auto_fit_model_version=7,binary_features=['stage-dump (inactive: all MAPLE env vars removed)'],input_preflight_completed=True,provenance_map_origin='complete repaired branch31 snapshot');save();env={k:v for k,v in os.environ.items() if not k.startswith('MAPLE_') and k not in ['FILTER','PREFERRED_RES','ALLOW_MISSING_BUDGET','ZONES','HUE_BINS']};env.update(RAYON_NUM_THREADS='4',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',PYTHONUNBUFFERED='1')
workspace=root/'workspace';workers=root/'render-workers';workers.mkdir();render_tasks=[]
for profile,selected in [('auto',[c for c in cases if c['name'].endswith('/baseline')]),('neutral',sorted(cases,key=lambda c:(not c['name'].endswith('/baseline'),c['name'])))]:
 folder=workspace/('auto_candidates' if profile=='auto' else 'candidates');folder.mkdir(parents=True)
 for offset in range(0,len(selected),4):render_tasks.append((len(render_tasks),profile,selected[offset:offset+4],folder))
assert len(render_tasks)==199

def render(task):
 index,profile,selected,folder=task;shard=workers/f'{index:03d}-{profile}.json';shard.write_text(json.dumps({'cases':selected})+'\n')
 with shard.with_suffix('.log').open('w') as log:result=subprocess.run([str(binary),'batch','--manifest',str(shard),'--out-dir',str(folder),'--profile',profile,'--no-bundled-lens'],env=env,stdout=log,stderr=subprocess.STDOUT)
 assert result.returncode==0,(index,profile,result.returncode)
 for c in selected:assert (folder/(c['name'].replace('/','_')+'.png')).is_file()
 for c in selected:
  if profile=='neutral' and c['name'] in anchor_hashes:assert sha(folder/(c['name'].replace('/','_')+'.png'))==anchor_hashes[c['name']],(c['name'],'source37 anchor differs from qualified frozen trial')
 receipt={'task':index,'profile':profile,'binary_sha256':identity['binary_sha256'],'manifest_sha256':sha(shard),'outputs':[{'path':str(folder/(c['name'].replace('/','_')+'.png')),'sha256':sha(folder/(c['name'].replace('/','_')+'.png'))} for c in selected]}
 shard.with_suffix('.receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 return index,profile,len(selected)
print('BRANCH37 full qualification:796fresh renders;806canonical comparisons;199render tasks. No merge/rebase.',flush=True)
with ThreadPoolExecutor(max_workers=4) as pool:
 for f in as_completed([pool.submit(render,t) for t in render_tasks]):
  index,profile,count=f.result();identity['completed_render_tasks']+=1;identity['newly_rendered_cases']=identity.get('newly_rendered_cases',0)+count;save();print('Rendered',identity['newly_rendered_cases'],'/796;',identity['completed_render_tasks'],'/199tasks;',profile,flush=True)
expected={('auto_candidates' if profile=='auto' else 'candidates',c['name'].replace('/','_')+'.png') for _,profile,selected,_ in render_tasks for c in selected};actual={(folder,p.name) for folder in ['candidates','auto_candidates'] for p in (workspace/folder).glob('*.png')};assert actual==expected and len(actual)==796
candidate_hashes=[{'path':str(workspace/folder/name),'sha256':sha(workspace/folder/name)} for folder,name in sorted(actual)];(root/'candidates-before-comparisons.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in candidate_hashes));identity.update(opposing_anchors_pixel_hash_matched=sorted(anchor_hashes));identity['phase']='parallel canonical comparisons';save()
harness=(scripts/'test_color_pipeline.sh').read_text();profiles=[('PY','neutral','down','candidates','',cases),('PY_AUTO','auto','down','auto_candidates','_auto',[c for c in cases if c['name'].endswith('/baseline')]),('PY_DETAIL','detail-fullres','full','candidates','',[c for c in cases if c['name'].split('/',1)[1].startswith(('sharpen','nr_'))])];cw=root/'comparison-workers';cw.mkdir();tasks=[]
for marker,profile,res,folder,suffix,selected in profiles:
 body=harness.split("<<'"+marker+"'",1)[1].split('\n',1)[1].split('\n'+marker,1)[0];selected=sorted(selected,key=lambda c:c['name'])
 for offset in range(0,len(selected),8):
  index=len(tasks);shard=cw/f'{index:03d}-{profile}.json';shard.write_text(json.dumps({'cases':selected[offset:offset+8]})+'\n');tasks.append((index,profile,res,folder,suffix,body,shard))
assert len(tasks)==123

def compare(task):
 index,profile,res,folder,suffix,body,shard=task;summary=shard.with_suffix('.jsonl')
 with shard.with_suffix('.log').open('w') as log:result=subprocess.run([sys.executable,'-',str(shard),str(workspace/folder),str(scripts/'compare_images.py'),res,'',str(budgets),'','','12',suffix],input=body,text=True,env=env|{'MAPLE_QUAL_SUMMARY':str(summary)},stdout=log,stderr=subprocess.STDOUT)
 records=[json.loads(l) for l in summary.read_text().splitlines()];assert len(records)==1 and result.returncode in (0,1),(index,result.returncode);record=records[0];assert record['errors']==0 and record['compared']>0,(index,record);return index,profile,record
results={}
with ThreadPoolExecutor(max_workers=8) as pool:
 for f in as_completed([pool.submit(compare,t) for t in tasks]):
  index,profile,record=f.result();results[index]=(profile,record);identity['completed_comparison_tasks']+=1;save();print('Compared',identity['completed_comparison_tasks'],'/123tasks;',profile,record['compared'],'cases',record['breaches'],'breaches',flush=True)
merged=[]
for marker,profile,res,folder,suffix,selected in profiles:
 records=[rec for index,(p,rec) in sorted(results.items()) if p==profile];rows=sorted([row for rec in records for row in rec['cases']],key=lambda r:(r['fixture'],r['case']));keys=[(row['fixture'],row['case']) for row in rows];expected_keys={(c['name'].split('/',1)[0],c['name'].split('/',1)[1]+suffix) for c in selected};assert len(keys)==len(set(keys)) and set(keys)==expected_keys
 compared=[row for row in rows if row['status'] in ('passed','breach')];summary={k:sum(rec[k] for rec in records) for k in ['compared','breaches','skipped_no_raw','skipped_no_candidate','skipped_no_reference','errors']};assert summary['compared']==len(compared);summary.update(grand_mean_deltaE=sum(row['mean'] for row in compared)/len(compared),cases=rows)
 if profile=='neutral':
  for field,name in [('grand_bias_r','bR'),('grand_bias_g','bG'),('grand_bias_b','bB')]:summary[field]=sum(row[name] for row in compared)/len(compared)
 else:summary['profile']=profile
 merged.append(summary)
(root/'qualification-summaries.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in merged));rows=[row for s in merged for row in s['cases'] if row['status'] in ('passed','breach','error')];failed=[row for row in rows if row['status']!='passed'];(root/'case-ledger.json').write_text(json.dumps(rows,indent=2)+'\n');(root/'failures.json').write_text(json.dumps(failed,indent=2)+'\n');identity['phase']='revalidating provenance';save()
changed=[e['path'] for e in inputs if sha(e['path'])!=e['sha256']];changed_candidates=[e['path'] for e in candidate_hashes if sha(e['path'])!=e['sha256']];identity.update(comparisons=sum(s['compared'] for s in merged),failures=len(failed),unique_cases=len({(row['fixture'],row['case']) for row in rows}),unique_failed_cases=len({(row['fixture'],row['case']) for row in failed}),changed_inputs=changed,changed_candidates=changed_candidates,binary_unchanged=sha(binary)==identity['binary_sha256'],passes=[{k:v for k,v in s.items() if k!='cases'} for s in merged]);assert [(s['compared'],s['errors']) for s in merged]==[(606,0),(20,0),(180,0)];coverage=identity['comparisons']==806 and identity['unique_cases']==796 and not changed and not changed_candidates and identity['binary_unchanged'];identity.update(complete_coverage=coverage,phase='validating accounting' if coverage else 'invalid coverage or provenance',finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat());save()
with (root/'accounting.log').open('w') as log:subprocess.run([sys.executable,str(scripts/'color_qualification_accounting.py'),str(root/'qualification-summaries.jsonl')],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
assert coverage
identity.update(accounting_passed=True,phase='complete');save()
old=set(json.loads((repo/'test-fixtures/qualification/color-suite-5000-incremental-ledger.json').read_text())['remaining_cases']);now={row['fixture']+'/'+row['case'] for row in failed};delta={'prior_working_failures':len(old),'current_unique_failed_cases':len(now),'cleared':sorted(old-now),'new_failures':sorted(now-old)};(root/'matched-delta.json').write_text(json.dumps(delta,indent=2)+'\n');original_failures={row['fixture']+'/'+row['case'] for row in json.loads((base/'failures.json').read_text())};(root/'matched-original-delta.json').write_text(json.dumps({'captured_main_unique_failures':len(original_failures),'current_unique_failed_cases':len(now),'cleared':sorted(original_failures-now),'new_failures':sorted(now-original_failures)},indent=2)+'\n');print('BRANCH37 FULL SUITE COMPLETE',json.dumps({k:identity[k] for k in ['comparisons','failures','unique_cases','unique_failed_cases','complete_coverage']}),'cleared',len(delta['cleared']),'new',len(delta['new_failures']),flush=True)
prior35=json.loads((r/'branch35-full-suite/case-ledger.json').read_text())
case_key=lambda row:(row['fixture'],row['case'],row['profile'])
assert {case_key(row) for row in prior35}=={case_key(row) for row in rows}
prior35fail={case_key(row) for row in prior35 if row['status']=='breach'};currentfail={case_key(row) for row in failed}
(root/'matched-branch35-delta.json').write_text(json.dumps({'baseline_source':'bfe563ae2689cbfebdcf432a03cc0d17c692ecee','baseline_failures':len(prior35fail),'current_failures':len(currentfail),'cleared':['/'.join(k) for k in sorted(prior35fail-currentfail)],'new_failures':['/'.join(k) for k in sorted(currentfail-prior35fail)]},indent=2)+'\n')
print('SOURCE35 MATCHED DELTA',len(prior35fail-currentfail),'cleared',len(currentfail-prior35fail),'new',flush=True)
prior36=json.loads((r/'branch36-full-suite/case-ledger.json').read_text())
assert {case_key(row) for row in prior36}=={case_key(row) for row in rows}
prior36fail={case_key(row) for row in prior36 if row['status']=='breach'}
(root/'matched-branch36-delta.json').write_text(json.dumps({'baseline_source':'b4523b79e616f2745f3b0a7e8e1c60b9bff08424','baseline_failures':len(prior36fail),'current_failures':len(currentfail),'cleared':['/'.join(k) for k in sorted(prior36fail-currentfail)],'new_failures':['/'.join(k) for k in sorted(currentfail-prior36fail)]},indent=2)+'\n')
print('SOURCE36 MATCHED DELTA',len(prior36fail-currentfail),'cleared',len(currentfail-prior36fail),'new',flush=True)
raise SystemExit(1 if failed or not coverage else 0)
