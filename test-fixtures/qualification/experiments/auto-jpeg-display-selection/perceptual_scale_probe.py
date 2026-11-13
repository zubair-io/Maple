from pathlib import Path
import json
import numpy as np
import colour
from scipy.sparse import csr_matrix

root=Path(__file__).resolve().parent
d=json.loads((root/'diagnostic_0005/diagnostic/auto_fit_observations.json').read_text())
prior=np.array(d['prior'],dtype=np.float32).reshape(-1,3)
proposal=np.array(d['artifact'],dtype=np.float32).reshape(-1,3)
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
for fraction in [1.,.5,.25,.125,.0625]:
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
(root/'perceptual-scale-probe.json').write_text(json.dumps(reports,indent=2)+'\n')
