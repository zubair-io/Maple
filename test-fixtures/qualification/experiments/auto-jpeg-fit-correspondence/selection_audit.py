from pathlib import Path
import json, subprocess
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


lab = lambda rgb: colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
d=json.loads((root/'diagnostic_0015/diagnostic/auto_fit_observations.json').read_text());prior=np.array(d['prior']).reshape(-1,3);candidate=np.load(root/'aligned-9-artifact.npy');report=[]
for kind,rows in [('native',d['native']),('display',d['display'] or d['native'])]:
 a=rows_matrix(rows,'artifact_weights',33**3);target=np.array([r['target'] for r in rows]);base=np.array([r['baseline'] for r in rows]);proposed=a@candidate;mask=np.array([r['validation'] for r in rows]) if kind=='native' else np.ones(len(rows),dtype=bool);regions=np.array([r['region'] for r in rows]);luma=target@np.array([.2126,.7152,.0722]);inside=np.array([r['in_bias_region'] for r in rows])
 for step in [0,1,.5,.25,.125,.0625]:
  out=base+(proposed-base)*step;e=out-target;de=colour.delta_E(lab(out),lab(target),method='CIE 2000');bde=colour.delta_E(lab(base),lab(target),method='CIE 2000');r={'kind':kind,'step':step,'mae':np.abs(e[mask]).mean(0).tolist(),'mse':(e[mask]**2).mean(0).tolist(),'p95_rgb':np.percentile(np.abs(e),95,axis=0).tolist(),'mean_de':float(de[mask].mean()),'p95_de':float(np.percentile(de[mask],95)),'worst_regional_de_change':max(float((de-bde)[regions==i].mean()) for i in range(64)),'signed_bias':e[inside].mean(0).tolist(),'bands':[]}
  for lo,hi in [(0,.25),(.25,.5),(.5,.75),(.75,1.0001)]:
   take=(luma>=lo)&(luma<hi)
   if take.sum()>=100:r['bands'].append({'luma':[lo,hi],'mae':np.abs(e[take]).mean(0).tolist()})
  report.append(r)
(root/'selection-audit-0015.json').write_text(json.dumps(report,indent=2)+'\n')
for r in report:print(r,flush=True)
