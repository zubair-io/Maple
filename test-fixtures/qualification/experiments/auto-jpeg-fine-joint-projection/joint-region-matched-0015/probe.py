from pathlib import Path
import json,sys,subprocess,time
import numpy as np
import colour
from scipy.sparse import csr_matrix,diags,vstack
from scipy.sparse.linalg import cg,LinearOperator
root=Path(__file__).resolve().parent;source=root.parent.parent/'auto-jpeg-fine-diagnostic-inputs/pilot_0015/diagnostic'
data=json.loads((source/'auto_fit_observations.json').read_text());n=data['prior_size'];count=n**3;step=json.loads((source/'auto_fit_step.json').read_text())['fraction'];prior=np.array(data['prior']).reshape(-1,3);current=np.array(json.loads((source/'auto_fine_refinement.json').read_text())['origin_artifact']).reshape(-1,3)
def matrix(rows):
 vals=[];ids=[];offs=[0]
 for row in rows:
  for i,w in row['artifact_weights']:vals.append(w);ids.append(i)
  offs.append(len(vals))
 return csr_matrix((vals,ids,offs),shape=(len(rows),count))
sets=[];mats=[];targets=[];groups=[];off=0
for name,rows in [('native',data['refinement_native']),('display',data['refinement_display'])]:
 a=matrix(rows);pop=np.array([r['population'] for r in rows]);y=np.array([r['target'] for r in rows]);train=np.array([not r['validation'] for r in rows]);sets.append((name,rows,a,pop,y,train));mats.append(a[train]);targets.append(y[train]);take=np.flatnonzero(train);p=pop[train];indices=np.arange(len(take))+off
 if name=='native':
  band=np.searchsorted([.1,.25,.5,.75],y[train]@np.array([.2126,.7152,.0722]),side='right');selections=[np.ones(len(take),bool)]+[band==i for i in range(5)]
 else:
  region=np.array([r['region'] for r in rows])[train];selections=[region==i for i in range(64)]
 for mask in selections:
  if mask.any():groups.append((indices[mask],p[mask]/p[mask].sum()))
 off+=len(take)
a=vstack(mats,format='csr');at=a.T.tocsr();y=np.concatenate(targets);base=a@current
values=[];indices=[];offsets=[0]
for ids,w in groups:values.extend(w);indices.extend(ids);offsets.append(len(values))
g=csr_matrix((values,indices,offsets),shape=(len(groups),len(y)));gt=g.T.tocsr()
node=np.arange(count);ei=[];ej=[]
for axis,stride in enumerate([1,n,n*n]):
 lo=node[(node//stride)%n<n-1];ei.extend(lo);ej.extend(lo+stride)
ei=np.array(ei);ej=np.array(ej);idx=np.arange(len(ei));edges=csr_matrix((np.r_[np.ones(len(ei)),-np.ones(len(ei))],(np.r_[idx,idx],np.r_[ei,ej])),shape=(len(ei),count))
reg=edges.T@edges*(1e-5*8/(n-1)*20)+diags(np.full(count,1e-8*(9**3/count)*20))
pop_train=np.concatenate([pop[train] for _,_,_,pop,_,train in sets]);confidence=np.asarray(a.power(2).multiply(pop_train[:,None]).sum(0)).ravel()/pop_train.sum()+1e-8
current.astype('<f4').tofile(root/'prior.bin');confidence.astype('<f8').tofile(root/'confidence.bin')
def project(candidate):
 candidate.astype('<f4').tofile(root/'candidate.bin')
 subprocess.run([str(root/'project-probe'),str(root/'prior.bin'),str(root/'candidate.bin'),str(root/'confidence.bin'),str(root/'projected.bin')],check=True)
 return np.fromfile(root/'projected.bin',dtype='<f4').reshape(-1,3).astype(float)
display=sets[-1];_,display_rows,display_matrix,display_pop,display_target,display_train=display
b=display_matrix[display_train];bt=b.T.tocsr();yp=display_target[display_train];wp=display_pop[display_train];regions=np.array([r['region'] for r in display_rows])[display_train]
def delta_e(prediction):
 return colour.delta_E(colour.XYZ_to_Lab(colour.sRGB_to_XYZ(prediction)),colour.XYZ_to_Lab(colour.sRGB_to_XYZ(yp)),method='CIE 2000')
def region_means(error):
 return np.array([np.average(error[regions==i],weights=wp[regions==i]) for i in range(64)])
origin_de=region_means(delta_e(b@current))
def constrain_regions(candidate):
 from scipy.optimize import minimize
 fixed=np.arange(count);fixed=(fixed%n==fixed//n%n)&(fixed//n%n==fixed//(n*n))
 for iteration in range(12):
  pred=b@candidate;de=delta_e(pred);means=region_means(de)
  if np.max(means-origin_de)<=.06:return candidate
  gradient=np.empty_like(pred)
  for c in range(3):
   plus=pred.copy();minus=pred.copy();plus[:,c]+=1e-4;minus[:,c]-=1e-4
   gradient[:,c]=(delta_e(plus)-delta_e(minus))/(2e-4)
  directions=[]
  for region in range(64):
   mask=regions==region;weighted=np.zeros(len(yp));weighted[mask]=wp[mask]/wp[mask].sum();direction=np.column_stack([bt@(weighted*gradient[:,c]) for c in range(3)]);direction[fixed]=0.;directions.append(direction.ravel())
  j=np.array(directions);gram=j@j.T;violation=means-origin_de-.05
  fn=lambda v:(.5*v@gram@v-violation@v,gram@v-violation)
  result=minimize(fn,np.zeros(64),method='L-BFGS-B',jac=True,bounds=[(0,None)]*64,options={'maxiter':1000,'ftol':1e-13,'gtol':1e-9})
  correction=(j.T@result.x).reshape(-1,3)
  before=np.max(means-origin_de);best=candidate
  for fraction in [1.,.5,.25,.125]:
   tested=project(candidate-fraction*correction);after=np.max(region_means(delta_e(b@tested))-origin_de)
   if after<before:before=after;best=tested
  if np.array_equal(best,candidate):return candidate
  candidate=best
 return candidate

def score(artifact):
 ratios=g@np.abs(a@artifact-y)/.05;maximum=ratios.max(axis=0);return float(np.sum(maximum+np.log(np.exp(16*(ratios-maximum)).sum(axis=0))/16))
def stats(artifact,label):
 report={'label':label,'diagnostic_only':True,'training_objective':score(artifact),'sets':[]}
 for name,rows,design,pop,target,train in sets:
  pred=design@artifact;err=np.abs(pred-target);de=colour.delta_E(colour.XYZ_to_Lab(colour.sRGB_to_XYZ(pred)),colour.XYZ_to_Lab(colour.sRGB_to_XYZ(target)),method='CIE 2000');regions=np.array([r['region'] for r in rows]);bands=np.searchsorted([.1,.25,.5,.75],target@np.array([.2126,.7152,.0722]),side='right')
  report['sets'].append({'name':name,'mean_de':float(np.average(de,weights=pop)),'heldout_mae_rgb':np.average(err[~train],axis=0,weights=pop[~train]).tolist(),'band_mae_rgb':[np.average(err[bands==i],axis=0,weights=pop[bands==i]).tolist() for i in range(5) if (bands==i).any()],'region_mean_de':[float(np.average(de[regions==i],weights=pop[regions==i])) for i in range(64)],'region_mae_rgb':[np.average(err[regions==i],axis=0,weights=pop[regions==i]).tolist() for i in range(64)]})
 return report
reports=[stats(current,'current0015')];origin=current.copy();artifact=current.copy();node=np.arange(count);free=((node%n!=node//n%n)|(node//n%n!=node//(n*n))).astype(float)
for iteration in range(1,7):
 start=time.monotonic();error=a@artifact-y;ratio=g@np.abs(error)/.05;maximum=ratio.max(axis=0);q=np.exp(16*(ratio-maximum));q/=q.sum(axis=0);weighted=gt@(q/.05);candidate=origin.copy();statuses=[]
 for c in range(3):
  weight=weighted[:,c]/np.sqrt(error[:,c]**2+(1/255)**2)
  op=LinearOperator((count,count),matvec=lambda v:free*(at@(weight*(a@(free*v)))+reg@(free*v))+(1-free)*v);diag=np.asarray(a.power(2).multiply(weight[:,None]).sum(0)).ravel()+reg.diagonal();diag=diag*free+(1-free);pre=LinearOperator(op.shape,matvec=lambda v:v/diag)
  delta,status=cg(op,free*(at@(weight*(y[:,c]-base[:,c]))),M=pre,x0=artifact[:,c]-origin[:,c],rtol=1e-6,maxiter=256);candidate[:,c]+=delta;statuses.append(status)
 before=score(artifact);accepted=False
 for fraction in [1.,.5,.25,.125,.0625]:
  tested=constrain_regions(project(artifact+fraction*(candidate-artifact)))
  if score(tested)<before:artifact=tested;accepted=True;break
 report=stats(artifact,f'fine absolute objective iteration{iteration}');report.update(accepted=accepted,cg_status=statuses,seconds=time.monotonic()-start);reports.append(report);np.save(root/f'candidate-{iteration}.npy',artifact);(root/'results.json').write_text(json.dumps(reports,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='sets'}),flush=True)
 if not accepted:break
