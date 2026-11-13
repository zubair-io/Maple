from pathlib import Path
import json,subprocess
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


data=json.loads((root.parent/'diagnostic_0015/diagnostic/auto_fit_observations.json').read_text())
rows=data['display'] or data['native'];size=data['prior_size'];count=size**3
fine=rows_matrix(rows,'artifact_weights',count);p=subdivision(9,size);a=(fine@p).tocsr()
prior=np.array(data['prior']).reshape(-1,3);current=np.array(data['artifact']).reshape(-1,3)
y=np.array([r['target'] for r in rows]);population=np.array([r['population'] for r in rows]);train=np.array([not r['validation'] for r in rows]);weights=population[train];total=weights.sum();design=a[train];xt=design.T.tocsr()
ei,ej=[],[]
for i in range(9**3):
 for coordinate,stride in [(i%9,1),(i//9%9,9),(i//81,81)]:
  if coordinate<8:ei.append(i);ej.append(i+stride)
idx=np.arange(len(ei));edges=csr_matrix((np.r_[np.ones(len(ei)),-np.ones(len(ei))],(np.r_[idx,idx],np.r_[ei,ej])),shape=(len(ei),9**3));regularizer=edges.T@edges*1e-5+diags(np.full(9**3,1e-8))
operator=LinearOperator((9**3,9**3),matvec=lambda v:xt@(weights*(design@v))/total+regularizer@v)
diagonal=np.asarray(design.power(2).multiply(weights[:,None]).sum(0)).ravel()/total+regularizer.diagonal();preconditioner=LinearOperator(operator.shape,matvec=lambda v:v/diagonal)
confidence=np.asarray(fine[train].power(2).multiply(weights[:,None]).sum(0)).ravel()/total+1e-8
prior.astype('<f4').tofile(root/'prior.bin');confidence.astype('<f8').tofile(root/'confidence.bin')
lab=lambda rgb:colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
ref_lab=lab(y)
def percentile(values):
 order=np.argsort(values);cum=np.cumsum(population[order]);return float(values[order][np.searchsorted(cum,int(cum[-1])*95//100,side='right')])
def stats(artifact,label):
 output=fine@artifact;de=colour.delta_E(lab(output),ref_lab,method='CIE 2000');error=np.abs(output-y)
 return {'label':label,'qualification':'cached eval-then-BOX operator diagnostic on original coordinates, not physical qualification','mean_de':float(np.average(de,weights=population)),'p95_de':percentile(de),'mae_rgb':np.average(error,axis=0,weights=population).tolist(),'p95_rgb':[percentile(error[:,c]) for c in range(3)],'per_region_mean_de':[float(np.average(de[np.array([r['region'] for r in rows])==i],weights=population[np.array([r['region'] for r in rows])==i])) for i in range(64)]}
def transported_targets(prediction,reference,weight):
 order=np.argsort(prediction,kind='stable');target_order=np.argsort(reference,kind='stable');starts=np.r_[0,1+np.flatnonzero(np.diff(prediction[order])!=0)]
 group_weight=np.add.reduceat(weight[order],starts);source_mass=np.r_[0,np.cumsum(group_weight)]
 target_mass=np.r_[0,np.cumsum(weight[target_order])];target_integral=np.r_[0,np.cumsum(weight[target_order]*reference[target_order])]
 assigned=np.diff(np.interp(source_mass,target_mass,target_integral))/group_weight
 result=np.empty(len(prediction));result[order]=np.repeat(assigned,np.diff(np.r_[starts,len(order)]));return result
reports=[stats(current,'current selected original-paired artifact')]
for iteration in range(1,4):
 predicted=fine[train]@current;targets=np.column_stack([transported_targets(predicted[:,c],y[train,c],weights) for c in range(3)])
 rhs=xt@(weights[:,None]*(targets-predicted))/total
 solved=[cg(operator,rhs[:,c],M=preconditioner,rtol=1e-7,maxiter=256) for c in range(3)];delta=np.column_stack([v[0] for v in solved]);candidate=np.clip(current+p@delta,0,1)
 candidate.astype('<f4').tofile(root/'candidate.bin');subprocess.run([str(root.parent.parent/'auto-jpeg-fit-correspondence/project-probe'),str(root/'prior.bin'),str(root/'candidate.bin'),str(root/'confidence.bin'),str(root/'projected.bin')],check=True)
 current=np.fromfile(root/'projected.bin',dtype='<f4').reshape(-1,3);np.save(root/f'artifact-{iteration}.npy',current);report=stats(current,f'rank-transport iteration {iteration}');report['cg_status']=[v[1] for v in solved];reports.append(report);print({k:v for k,v in report.items() if k!='per_region_mean_de'},flush=True)
(root/'results.json').write_text(json.dumps(reports,indent=2)+'\n')
