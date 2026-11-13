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
reports=[]
for name in sorted(audit):
 source=gray(np.asarray(Image.open(images/(name+'-before.png')))/255)
 target=gray(np.asarray(Image.open(images/(name+'-reference.png')))/255)
 start=time.monotonic()
 try:
  affine,scores=estimate(source,target)
  known=np.array(audit[name]['affine_source_to_reference'])
  h,w=target.shape;grid=np.array([[x,y,1]for y in [0,h/2,h-1]for x in [0,w/2,w-1]])
  difference=np.linalg.norm(grid@affine.T-grid@known.T,axis=1)
  row={'fixture':name,'status':'geometry estimation diagnostic ONLY; no renderer or gate change','source':'original pre-fix Auto PNG, independent of current candidate','affine_source_to_reference':affine.tolist(),'ecc_levels':scores,'max_grid_difference_from_root_sift_pixels':float(difference.max()),'median_grid_difference_from_root_sift_pixels':float(np.median(difference)),'seconds':time.monotonic()-start}
 except (cv2.error,KeyError)as error:row={'fixture':name,'error':str(error),'seconds':time.monotonic()-start}
 reports.append(row);print(json.dumps(row),flush=True)
(r/'ecc-results.json').write_text(json.dumps(reports,indent=2)+'\n')
