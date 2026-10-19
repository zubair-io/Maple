from pathlib import Path
import json
import numpy as np
import colour
from scipy.sparse import csr_matrix, diags
from scipy.sparse.linalg import cg, LinearOperator

root = Path(__file__).resolve().parent

def rows_matrix(rows, key, count):
    values, indices, offsets = [], [], [0]
    for row in rows:
        for index, weight in row[key]:
            values.append(weight)
            indices.append(index)
        offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(len(rows), count))

def subdivision(size, fine):
    values, indices, offsets = [], [], [0]
    for z in range(fine):
        for y in range(fine):
            for x in range(fine):
                p = np.array([x, y, z]) * (size - 1) / (fine - 1)
                lo = np.minimum(np.floor(p).astype(int), size - 2)
                f = p - lo
                axes = np.argsort(-f, kind='stable')
                stride = np.array([1, size, size*size])
                start = int(lo @ stride)
                indices.extend([start, start+int(stride[axes[0]]), start+int(stride[axes[0]]+stride[axes[1]]), start+int(stride.sum())])
                values.extend([1-f[axes[0]], f[axes[0]]-f[axes[1]], f[axes[1]]-f[axes[2]], f[axes[2]]])
                offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(fine**3, size**3))


from scipy.linalg import solve
root=Path(__file__).resolve().parent
d=json.loads((root/'diagnostic_0011/diagnostic/auto_fit_observations.json').read_text())
native=d['native'];display=d['display'] or native
prior=np.array(d['prior']).reshape(-1,3);fine_size=d['prior_size'];p=subdivision(9,fine_size)
xf=rows_matrix(native,'artifact_weights',fine_size**3);df=rows_matrix(display,'artifact_weights',fine_size**3)
x=(xf@p).tocsr();dx=(df@p).tocsr();target=np.array([r['target']for r in native]);dt=np.array([r['target']for r in display]);base=xf@prior;db=df@prior
train=np.array([not r['validation']for r in native]);dtrain=np.array([not r['validation']for r in display]);luma=np.array([.2126,.7152,.0722]);nb=np.searchsorted([.1,.25,.5,.75],target@luma,side='right');dband=np.searchsorted([.1,.25,.5,.75],dt@luma,side='right')
from PIL import Image
w,h=Image.open(root.parent/'auto-jpeg-rgb-pass-selection/full-suite/test_0011/embedded.png').size
nx,ny=min(w,256),min(h,256);mask64=(1<<64)-1
def mix(v):
 v=((v^(v>>30))*0xbf58476d1ce4e5b9)&mask64;v=((v^(v>>27))*0x94d049bb133111eb)&mask64;return v^(v>>31)
inner=[]
for gy in range(ny):
 for gx in range(nx):
  seed=mix((((gx+1)*0x9e3779b97f4a7c15)&mask64)^(gy+1));x0,x1=gx*w//nx,(gx+1)*w//nx;y0,y1=gy*h//ny,(gy+1)*h//ny;px=x0+seed%(x1-x0);py=y0+(seed>>32)%(y1-y0);inner.append(round(w*.1)<=px<w-round(w*.1)and round(h*.1)<=py<h-round(h*.1))
inner=np.array(inner)
ei,ej=[],[]
for i in range(729):
 for axis,stride in enumerate([1,9,81]):
  if [i%9,i//9%9,i//81][axis]<8:ei.append(i);ej.append(i+stride)
k=np.arange(len(ei));edges=csr_matrix((np.r_[np.ones(len(ei)),-np.ones(len(ei))],(np.r_[k,k],np.r_[ei,ej])),shape=(len(ei),729));reg=(edges.T@edges*1e-5+diags(np.full(729,1e-8))).toarray()
def system(a,errors,weights):return (a.T@a.multiply(weights[:,None])).toarray(),np.asarray(a.T@(errors*weights[:,None]))
display_system=system(dx[dtrain],(dt-db)[dtrain],np.ones(dtrain.sum())/dtrain.sum())
methods={}
methods['uniform_display']=display_system
counts=np.bincount(dband[dtrain],minlength=5);pop=np.count_nonzero(counts);weights=1./(pop*counts[dband[dtrain]])
methods['balanced_display']=system(dx[dtrain],(dt-db)[dtrain],weights)
counts=np.bincount(nb[train],minlength=5);pop=np.count_nonzero(counts);weights=1./(pop*counts[nb[train]])
native_system=system(x[train],(target-base)[train],weights)
methods['display_and_balanced_native']=tuple((a+b)*.5 for a,b in zip(display_system,native_system))
moments=[];residuals=[]
for region in [np.ones(len(native),dtype=bool),inner]:
 for band in range(5):
  selected=train&region&(nb==band)
  if selected.any():moments.append(np.asarray(x[selected].mean(axis=0)).ravel());residuals.append((target-base)[selected].mean(axis=0))
m=np.array(moments);e=np.array(residuals);moment_system=(m.T@m/len(m),m.T@e/len(m))
methods['display_and_native_moments']=tuple((a+b)*.5 for a,b in zip(display_system,moment_system))
inner_train=train&inner
counts=np.bincount(nb[inner_train],minlength=5);pop=np.count_nonzero(counts);weights=1./(pop*counts[nb[inner_train]])
inner_system=system(x[inner_train],(target-base)[inner_train],weights)
methods={
 'three_pixel_families':tuple((a+b+c)/3 for a,b,c in zip(display_system,native_system,inner_system)),
 'balanced_native_and_inner':tuple((a+b)*.5 for a,b in zip(native_system,inner_system))
}
lab=lambda v:colour.XYZ_to_Lab(colour.sRGB_to_XYZ(v))
target_lab=lab(dt);before_de=colour.delta_E(lab(db),target_lab,method='CIE 2000');regions=np.array([r['region']for r in display]);reports=[]
for name,(a,b) in methods.items():
 delta=solve(a+reg,b,assume_a='pos');artifact=np.clip(prior+p@delta,0,1);pred=xf@artifact;dp=df@artifact;de=colour.delta_E(lab(dp),target_lab,method='CIE 2000');report={'method':name,'status':'cached operator diagnosis after bounds before constraint projection; NOT physical qualification','display_mean_de':[float(before_de.mean()),float(de.mean())],'display_p95_de':[float(np.percentile(before_de,95)),float(np.percentile(de,95))],'max_regional_de_increase':max(float((de-before_de)[regions==r].mean())for r in range(64)),'native_bands':[]}
 for band in range(5):
  mask=(nb==band)
  if not mask.any():continue
  item={'band':band,'count':int(mask.sum()),'mae':np.abs(pred[mask]-target[mask]).mean(axis=0).tolist()}
  mask&=inner
  if mask.any():item['inner_bias']=(pred[mask]-target[mask]).mean(axis=0).tolist()
  report['native_bands'].append(item)
 reports.append(report);print(json.dumps(report),flush=True)
(root/'0011-weighted-families.json').write_text(json.dumps(reports,indent=2)+'\n')
