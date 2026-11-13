from pathlib import Path
import json,sys
import cv2
import numpy as np
sys.path.insert(0,'/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts')
import auto_profile_quality as q

root=Path(__file__).resolve().parent
rows=json.loads((root.parent/'auto-jpeg-residual-field/full-suite/summary.json').read_text())['cases']
out=[]
sift=cv2.SIFT_create(nfeatures=10000)
def descriptors(image):
    gray=cv2.cvtColor(np.rint(image*255).astype(np.uint8),cv2.COLOR_RGB2GRAY)
    points,features=sift.detectAndCompute(gray,None)
    if features is None:return points,features
    features=np.sqrt(features/(features.sum(axis=1,keepdims=True)+1e-12))
    return points,features

for row in rows:
    name=row['fixture']
    if 'quality' not in row:continue
    case=(root/'pilot'/name) if name=='test_0015' else root.parent/'auto-jpeg-residual-field/full-suite'/name
    candidate,reference=q.load_display_pair(case/'auto.png',case/'embedded.png')
    cp,cd=descriptors(candidate)
    rp,rd=descriptors(reference)
    matches=cv2.BFMatcher(cv2.NORM_L2).knnMatch(cd,rd,k=2)
    good=[a for a,b in matches if a.distance<0.75*b.distance]
    a=np.float32([cp[m.queryIdx].pt for m in good])
    b=np.float32([rp[m.trainIdx].pt for m in good])
    affine,mask=cv2.estimateAffinePartial2D(a,b,method=cv2.RANSAC,ransacReprojThreshold=1.5,maxIters=10000,confidence=.999)
    result={'fixture':name,'status':'feature registration diagnostic ONLY; no harness compensation or passing claim','matches':len(good)}
    if affine is not None:
        keep=mask.ravel().astype(bool)
        predicted=np.c_[a,np.ones(len(a))]@affine.T
        residual=b-predicted
        distance=np.linalg.norm(b-a,axis=1)
        result.update(affine_source_to_reference=affine.tolist(),inliers=int(keep.sum()),identity_displacement_median=float(np.median(distance[keep])),identity_displacement_p95=float(np.percentile(distance[keep],95)),affine_residual_p95=float(np.percentile(np.linalg.norm(residual[keep],axis=1),95)))
        warped=cv2.warpAffine(candidate,affine,(reference.shape[1],reference.shape[0]),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
        result['original_metrics']=q.evaluate(candidate,reference)['metrics']
        result['diagnostically_aligned_metrics']=q.evaluate(warped,reference)['metrics']
        regions=[]
        for y in range(8):
            for x in range(8):
                selected=keep&(a[:,0]>=x*candidate.shape[1]/8)&(a[:,0]<(x+1)*candidate.shape[1]/8)&(a[:,1]>=y*candidate.shape[0]/8)&(a[:,1]<(y+1)*candidate.shape[0]/8)
                if selected.sum()>=4:regions.append({'row':y,'column':x,'count':int(selected.sum()),'median_affine_residual_xy':np.median(residual[selected],axis=0).tolist()})
        result['regions']=regions
    out.append(result)
    print(json.dumps({k:v for k,v in result.items()if k not in ['regions','original_metrics','diagnostically_aligned_metrics']}),flush=True)
(root/'correspondence-audit.json').write_text(json.dumps(out,indent=2)+'\n')
