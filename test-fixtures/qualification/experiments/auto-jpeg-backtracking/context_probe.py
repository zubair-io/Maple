from pathlib import Path
import json
import numpy as np
import colour
from scipy.spatial import cKDTree

root = Path(__file__).resolve().parent
cases = [('test_0015',root/'operator-diagnostics/test_0015/diagnostic/auto_fit_observations.json'),('test_0017',root.parent/'auto-jpeg-residual-field/operator-diagnostics/test_0017/diagnostic/auto_fit_observations.json')]
reports=[]
lab=lambda rgb:colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
for name,path in cases:
    d=json.loads(path.read_text())
    rows=d['native']
    source=np.array([r['source'] for r in rows])
    target=np.array([r['target'] for r in rows])
    baseline=np.array([r['baseline'] for r in rows])
    train=np.array([not r['validation'] for r in rows])
    regions=np.array([r['region'] for r in rows])
    valid=np.flatnonzero(~train)
    target_lab=lab(target[valid])
    report={'fixture':name,'status':'held-out cached diagnostic only; neither a render nor a production proposal','sample_count':len(rows)}
    for kind in ['global-colour','within-display-region-colour']:
        prediction=np.empty_like(target[valid])
        distances=[]
        groups=[None] if kind=='global-colour' else range(64)
        for region in groups:
            fit=np.flatnonzero(train & ((regions==region) if region is not None else True))
            selected=np.flatnonzero((regions[valid]==region) if region is not None else np.ones(len(valid),dtype=bool))
            distance,indices=cKDTree(source[fit]).query(source[valid[selected]],k=16,workers=2)
            weight=1/(distance**2+1e-8)
            prediction[selected]=(target[fit[indices]]*weight[:,:,None]).sum(axis=1)/weight.sum(axis=1)[:,None]
            distances.extend(distance[:,0])
        de=colour.delta_E(lab(prediction),target_lab,method='CIE 2000')
        report[kind]={'mean_de':float(de.mean()),'p95_de':float(np.percentile(de,95)),'mae_rgb':np.abs(prediction-target[valid]).mean(axis=0).tolist(),'nearest_source_distance_p95':float(np.percentile(distances,95))}
    de=colour.delta_E(lab(baseline[valid]),target_lab,method='CIE 2000')
    report['baseline']={'mean_de':float(de.mean()),'p95_de':float(np.percentile(de,95))}
    reports.append(report)
    print(json.dumps(report),flush=True)
(root/'context-probe.json').write_text(json.dumps(reports,indent=2)+'\n')
