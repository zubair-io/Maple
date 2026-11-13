from pathlib import Path
import json
import numpy as np
import colour
from scipy.sparse import csr_matrix

root=Path(__file__).resolve().parent
d=json.loads((root/'diagnostic_0005/diagnostic/auto_fit_observations.json').read_text())
prior=np.array(d['prior'],dtype=np.float32).reshape(-1,3)
coarse=np.array(d['coarse'],dtype=np.float32).reshape(-1,3)
z,y,x=np.indices((33,33,33))
p=np.stack([x,y,z],axis=-1).reshape(-1,3).astype(np.float32)/32*8
lo=np.minimum(np.floor(p).astype(int),7);f=p-lo
axes=np.argsort(-f,axis=1,kind='stable');ordered=np.take_along_axis(f,axes,axis=1).astype(np.float32)
stride=np.array([1,9,81]);start=lo@stride
indices=np.column_stack([start,start+stride[axes[:,0]],start+stride[axes[:,0]]+stride[axes[:,1]],start+91])
w=np.column_stack([1-ordered[:,0],ordered[:,0]-ordered[:,1],ordered[:,1]-ordered[:,2],ordered[:,2]])
terms=coarse[indices]*w[:,:,None]
delta=((terms[:,0]+terms[:,1])+terms[:,2])+terms[:,3]
proposal=np.clip(prior+delta,0,1).astype(np.float32)
lab=lambda rgb:colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
scales={}
for name,rows in [('native',d['native']),('display',d['display'] or d['native'])]:
    values,indices,pointers=[],[],[0]
    for row in rows:
        for i,w in row['artifact_weights']:indices.append(i);values.append(w)
        pointers.append(len(values))
    x=csr_matrix((values,indices,pointers),shape=(len(rows),d['prior_size']**3))
    target=np.array([r['target']for r in rows])
    baseline=np.array([r['baseline']for r in rows])
    selected=np.array([r['validation']for r in rows]) if name=='native' else np.ones(len(rows),dtype=bool)
    base_de=colour.delta_E(lab(baseline),lab(target),method='CIE 2000')
    scales[name]=(rows,x,target,baseline,selected,base_de,lab(target))
reports=[]
for fraction in [1.]:
    artifact=proposal if fraction==1 else (prior+np.float32(fraction)*(proposal-prior)).astype(np.float32)
    report={'fraction':fraction,'status':'cached-operator diagnosis only; not a physical pass'}
    for name,(rows,x,target,baseline,selected,base_de,target_lab) in scales.items():
        prediction=x@artifact
        de=colour.delta_E(lab(prediction),target_lab,method='CIE 2000')
        p95=lambda values:float(np.partition(values,len(values)*95//100)[len(values)*95//100])
        entry={'mean_de':[float(base_de[selected].mean()),float(de[selected].mean())],'p95_de':[p95(base_de[selected]),p95(de[selected])],'mae_rgb':[np.abs(baseline[selected]-target[selected]).mean(axis=0).tolist(),np.abs(prediction[selected]-target[selected]).mean(axis=0).tolist()],'mse_rgb':[((baseline[selected]-target[selected])**2).mean(axis=0).tolist(),((prediction[selected]-target[selected])**2).mean(axis=0).tolist()]}
        if name=='display':
            regions=np.array([r['region']for r in rows]);entry['max_regional_mean_de_increase']=max(float((de-base_de)[regions==i].mean())for i in range(64))
        report[name]=entry
    reports.append(report)
    print(json.dumps(report),flush=True)
(root/'unprojected-scale-probe.json').write_text(json.dumps(reports,indent=2)+'\n')
