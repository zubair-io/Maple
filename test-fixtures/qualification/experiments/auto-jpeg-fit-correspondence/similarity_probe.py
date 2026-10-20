from pathlib import Path
import json,time
import cv2
import numpy as np
from PIL import Image
cv2.setNumThreads(2)
r=Path(__file__).resolve().parent
images=r.parent/'auto-jpeg-band-interior/gallery'
audit={x['fixture']:x for x in json.loads((r.parent/'auto-jpeg-sensor-gains/correspondence-audit.json').read_text())}
def gray(a):return np.asarray(a,dtype=np.float32)@np.array([.2126,.7152,.0722],dtype=np.float32)
def normalized(a,size):
 a=cv2.resize(a,size,interpolation=cv2.INTER_AREA)
 mean=cv2.GaussianBlur(a,(0,0),3)
 variance=np.maximum(cv2.GaussianBlur(a*a,(0,0),3)-mean*mean,0)
 return ((a-mean)/np.sqrt(variance+1e-4)).astype(np.float32)
def estimate(source,target):
 warp=np.eye(2,3,dtype=np.float32)
 previous=0
 levels=[]
 for edge in [128,256,512]:
  factor=edge/max(target.shape)
  size=(max(16,round(target.shape[1]*factor)),max(16,round(target.shape[0]*factor)))
  if previous:warp[:,2]*=edge/previous
  s=normalized(source,size);t=normalized(target,size)
  coefficient,warp=cv2.findTransformECC(t,s,warp,cv2.MOTION_AFFINE,(cv2.TERM_CRITERIA_COUNT|cv2.TERM_CRITERIA_EPS,150,1e-6),None,5)
  levels.append(float(coefficient));previous=edge
 warp[:,2]*=max(target.shape)/previous
 return cv2.invertAffineTransform(warp),levels

def bilinear(image,px,py):
 h,w=image.shape
 if np.any(px<1)or np.any(py<1)or np.any(px>w-2)or np.any(py>h-2):return None
 x=np.floor(px).astype(int);y=np.floor(py).astype(int);fx=px-x;fy=py-y
 a=image[y,x];b=image[y,x+1];c=image[y+1,x];d=image[y+1,x+1]
 value=(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy
 gx=(b-a)*(1-fy)+(d-c)*fy;gy=(c-a)*(1-fx)+(d-b)*fx
 return value,gx,gy

def stage(source,target,warp):
 h,w=target.shape;yy,xx=np.mgrid[round(h*.1):h-round(h*.1),round(w*.1):w-round(w*.1)]
 xx=xx.ravel();yy=yy.ravel();xn=(xx-(w-1)/2)/w;yn=(yy-(h-1)/2)/w;ones=np.ones(len(xx))
 params=np.array([(warp[0,0]-1)*w,warp[1,0]*w,warp[0,2]+(warp[0,0]-1)*(w-1)/2+warp[0,1]*(h-1)/2,warp[1,2]+warp[1,0]*(w-1)/2+(warp[1,1]-1)*(h-1)/2,1.,0.])
 ref=target[yy,xx]
 def evaluate(p):
  sample=bilinear(source,xx+p[0]*xn-p[1]*yn+p[2],yy+p[1]*xn+p[0]*yn+p[3])
  if sample is None:return None
  values,gx,gy=sample;error=p[4]*values+p[5]-ref
  return values,gx,gy,error,float(error@error/len(error))
 for iteration in range(80):
  values,gx,gy,error,cost=evaluate(params)
  jac=np.column_stack([params[4]*(gx*xn+gy*yn),params[4]*(-gx*yn+gy*xn),params[4]*gx,params[4]*gy,values,ones]);normal=jac.T@jac
  delta=np.linalg.solve(normal+np.diag(1e-4*(np.diag(normal)+1e-8)),-jac.T@error)
  accepted=False
  for fraction in [1.,.5,.25,.125,.0625,.03125]:
   trial=params+fraction*delta
   if abs(trial[0]/w)>.1 or abs(trial[1]/w)>.05 or abs(trial[2]/w)>.1 or abs(trial[3]/h)>.1 or not .25<trial[4]<4:continue
   tested=evaluate(trial)
   if tested is not None and tested[-1]<cost:
    params=trial;accepted=True;break
  if not accepted or np.max(np.abs(fraction*delta[:4]))<1e-4:break
 values,gx,gy,error,cost=evaluate(params);corr=float(np.corrcoef(values,ref)[0,1])
 warp=np.array([[1+params[0]/w,-params[1]/w,params[2]-params[0]/w*(w-1)/2+params[1]/w*(h-1)/2],[params[1]/w,1+params[0]/w,params[3]-params[1]/w*(w-1)/2-params[0]/w*(h-1)/2]],dtype=np.float64)
 return warp,corr,iteration+1

def estimate(source,target):
 warp=np.eye(2,3,dtype=np.float64);previous=0;levels=[]
 for edge in [128,256,512]:
  factor=edge/max(target.shape);size=(max(16,round(target.shape[1]*factor)),max(16,round(target.shape[0]*factor)))
  if previous:warp[:,2]*=edge/previous
  warp,correlation,iterations=stage(normalized(source,size),normalized(target,size),warp)
  levels.append({'correlation':correlation,'iterations':iterations});previous=edge
 warp[:,2]*=max(target.shape)/previous
 return cv2.invertAffineTransform(warp),levels
reports=[]
for name in sorted(audit):
 source=gray(np.asarray(Image.open(images/(name+'-before.png')))/255);target=gray(np.asarray(Image.open(images/(name+'-reference.png')))/255);start=time.monotonic()
 try:
  affine,scores=estimate(source,target);known=np.array(audit[name]['affine_source_to_reference']);h,w=target.shape;grid=np.array([[x,y,1]for y in [0,h/2,h-1]for x in [0,w/2,w-1]]);difference=np.linalg.norm(grid@affine.T-grid@known.T,axis=1)
  row={'fixture':name,'status':'own bounded similarity Gauss-Newton correspondence diagnostic; no production or gate change','affine_source_to_reference':affine.tolist(),'levels':scores,'max_grid_difference_from_root_sift_pixels':float(difference.max()),'seconds':time.monotonic()-start}
 except Exception as error:row={'fixture':name,'error':repr(error),'seconds':time.monotonic()-start}
 reports.append(row);print(json.dumps(row),flush=True)
(r/'similarity-results.json').write_text(json.dumps(reports,indent=2)+'\n')
