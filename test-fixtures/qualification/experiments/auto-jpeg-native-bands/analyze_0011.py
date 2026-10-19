from pathlib import Path
import json
import numpy as np
from PIL import Image
from scipy.sparse import csr_matrix
r=Path(__file__).resolve().parent;diag=r/'diagnostic_0011/diagnostic';d=json.loads((diag/'auto_fit_observations.json').read_text());rows=d['native'];prior=np.array(d['prior'],dtype=np.float32).reshape(-1,3);proposed=np.array(d['artifact'],dtype=np.float32).reshape(-1,3);step=json.loads((diag/'auto_fit_step.json').read_text())['fraction'];artifact=(prior+np.float32(step)*(proposed-prior)).astype(np.float32)
values,indices,offsets=[],[],[0]
for row in rows:
 for i,w in row['artifact_weights']:indices.append(i);values.append(w)
 offsets.append(len(values))
x=csr_matrix((values,indices,offsets),shape=(len(rows),d['prior_size']**3));target=np.array([row['target']for row in rows]);baseline=np.array([row['baseline']for row in rows]);prediction=x@artifact;validation=np.array([row['validation']for row in rows]);luma=target@np.array([.2126,.7152,.0722])
image=Image.open(r.parent/'auto-jpeg-rgb-pass-selection/full-suite/test_0011/embedded.png');tw,th=image.size;nx,ny=min(tw,256),min(th,256);mask64=(1<<64)-1
def mix(v):
 v=((v^(v>>30))*0xbf58476d1ce4e5b9)&mask64;v=((v^(v>>27))*0x94d049bb133111eb)&mask64;return v^(v>>31)
inner=[]
for gy in range(ny):
 for gx in range(nx):
  seed=mix((((gx+1)*0x9e3779b97f4a7c15)&mask64)^(gy+1));x0,x1=gx*tw//nx,(gx+1)*tw//nx;y0,y1=gy*th//ny,(gy+1)*th//ny;px=x0+seed%(x1-x0);py=y0+(seed>>32)%(y1-y0);inner.append(round(tw*.1)<=px<tw-round(tw*.1)and round(th*.1)<=py<th-round(th*.1))
inner=np.array(inner);reports=[]
for band,(lo,hi) in enumerate(zip([0,.1,.25,.5,.75],[.1,.25,.5,.75,1.000001])):
 bandmask=(luma>=lo)&(luma<hi)
 report={'band':band,'sampled_all':int(bandmask.sum()),'sampled_validation':int((bandmask&validation).sum())}
 for name,mask in [('full',bandmask),('held_out',bandmask&validation),('inner',bandmask&inner),('held_out_inner',bandmask&validation&inner)]:
  if not mask.any():continue
  report[name]={'count':int(mask.sum()),'mae_before':np.abs(baseline[mask]-target[mask]).mean(axis=0).tolist(),'mae_after':np.abs(prediction[mask]-target[mask]).mean(axis=0).tolist(),'bias_before':(baseline[mask]-target[mask]).mean(axis=0).tolist(),'bias_after':(prediction[mask]-target[mask]).mean(axis=0).tolist()}
 reports.append(report)
result={'source':'4cfbe38812','status':'sampled native-operator diagnostic, not a physical pass','preview_size':[tw,th],'step':step,'bands':reports};(r/'0011-band-diagnostic.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
