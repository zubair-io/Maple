from pathlib import Path
import json
import numpy as np
import colour
from PIL import Image
from scipy.sparse import csr_matrix
r=Path(__file__).resolve().parent
old=r.parent/'auto-jpeg-fit-correspondence'
d=json.loads((old/'diagnostic_0015/diagnostic/auto_fit_observations.json').read_text())
prior=np.array(d['prior']).reshape(-1,3)
registered=np.load(old/'aligned-9-artifact.npy')
step=json.loads((old/'diagnostic_0015/diagnostic/auto_fit_step.json').read_text())['fraction']
existing=prior+step*(np.array(d['artifact']).reshape(-1,3)-prior)
rows=d['display'] or d['native']
values,indices,offsets=[],[],[0]
for row in rows:
 for index,weight in row['artifact_weights']:values.append(weight);indices.append(index)
 offsets.append(len(values))
a=csr_matrix((values,indices,offsets),shape=(len(rows),len(prior)))
y=np.array([row['target'] for row in rows])
regions=np.array([row['region'] for row in rows]);inside=np.array([row['in_bias_region'] for row in rows])
w,h=Image.open(old/'full-suite/test_0015/embedded.png').size
nx,ny=min(w,256),min(h,256)
assert len(rows)==nx*ny and d['display'] is None
population=np.array([((gx+1)*w//nx-gx*w//nx)*((gy+1)*h//ny-gy*h//ny) for gy in range(ny) for gx in range(nx)])
assert population.sum()==w*h
lab=lambda rgb:colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
ref_lab=lab(y)
def p95(values,weights):
 order=np.argsort(values,kind='stable');rank=int(weights.sum())*95//100
 return float(values[order][np.searchsorted(np.cumsum(weights[order]),rank,side='right')])
def stats(artifact,label):
 out=a@artifact;e=out-y;ab=np.abs(e);de=colour.delta_E(lab(out),ref_lab,method='CIE 2000');metrics={}
 for c,name in enumerate('RGB'):
  metrics['mean_'+name]=float(np.average(ab[:,c],weights=population))/.05
  metrics['p95_'+name]=p95(ab[:,c],population)/.1
  metrics['clip_'+name]=float(np.average(((out[:,c]<=1/255)&(y[:,c]>.05))|((out[:,c]>=254/255)&(y[:,c]<.95)),weights=population))/.01
 metrics['mean_DE']=float(np.average(de,weights=population))/5
 metrics['p95_DE']=p95(de,population)/10
 for i in range(64):
  take=regions==i
  for c,name in enumerate('RGB'):metrics[f'tile_{i}_{name}']=float(np.average(ab[take,c],weights=population[take]))/.05
 bands=np.searchsorted([.1,.25,.5,.75],y@np.array([.2126,.7152,.0722]),side='right')
 for i in range(5):
  take=bands==i
  for c,name in enumerate('RGB'):
   if take.any():metrics[f'band_{i}_{name}']=float(np.average(ab[take,c],weights=population[take]))/.05
   inner=take&inside
   if inner.any():metrics[f'bias_{i}_{name}']=abs(float(np.average(e[inner,c],weights=population[inner])))/.05
 validation=np.array([row['validation'] for row in rows]); native_mse=np.average(e[validation]**2,axis=0,weights=population[validation]); native_mae=np.average(ab[validation],axis=0,weights=population[validation])
 return {'native_heldout_mse':native_mse.tolist(),'native_heldout_mae':native_mae.tolist(),'label':label,'status':'cached operator diagnostic; original coordinates; NOT physical qualification; gradient not represented','metrics_normalized_by_unchanged_limits':metrics,'worst_ratio':max(metrics.values()),'worst_metric':max(metrics,key=metrics.get),'failing_checks':sum(v>1 for v in metrics.values())}
reports=[stats(prior,'camera prior'),stats(existing,'existing selected paired artifact')]
for step in [1,.75,.5,.25,.125,.0625]:reports.append(stats(prior+step*(registered-prior),f'registered candidate {step}'))
for report in reports:
 report['new_failures_vs_existing']=[k for k,v in report['metrics_normalized_by_unchanged_limits'].items() if v>1 and reports[1]['metrics_normalized_by_unchanged_limits'][k]<=1]
 print({k:v for k,v in report.items() if k!='metrics_normalized_by_unchanged_limits'},flush=True)
(r/'selection-objective-audit.json').write_text(json.dumps(reports,indent=2)+'\n')
