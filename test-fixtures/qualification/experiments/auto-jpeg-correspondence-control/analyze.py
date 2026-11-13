from pathlib import Path
import json,sys,cv2,numpy as np
sys.path.insert(0,"/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts")
import auto_profile_quality as q
r=Path(__file__).resolve().parent
before={c["fixture"]:c for c in json.loads((r.parent/"auto-jpeg-sensor-gains/correspondence-audit.json").read_text())}
result=[]
sift=cv2.SIFT_create(nfeatures=10000)
def features(im):
 key,data=sift.detectAndCompute(cv2.cvtColor(np.rint(im*255).astype(np.uint8),cv2.COLOR_RGB2GRAY),None)
 return key,np.sqrt(data/(data.sum(axis=1,keepdims=True)+1e-12))
for name in ["test_0017","test_0012"]:
 candidate,reference=q.load_display_pair(r/name/"neutral-lens-off.png",r.parent/"auto-jpeg-residual-field/full-suite"/name/"embedded.png")
 kp,a=features(candidate);kr,b=features(reference)
 matches=cv2.BFMatcher(cv2.NORM_L2).knnMatch(a,b,k=2)
 good=[a for a,b in matches if a.distance<.75*b.distance]
 source=np.float32([kp[m.queryIdx].pt for m in good]);target=np.float32([kr[m.trainIdx].pt for m in good])
 affine,mask=cv2.estimateAffinePartial2D(source,target,method=cv2.RANSAC,ransacReprojThreshold=1.5,maxIters=10000,confidence=.999)
 keep=mask.ravel().astype(bool);prediction=np.c_[source,np.ones(len(source))]@affine.T
 row={"fixture":name,"status":"controlled geometry-only comparison; Neutral is deliberately not a colour qualification","default_lens_affine":before[name]["affine_source_to_reference"],"lens_off_affine":affine.tolist(),"lens_off_inliers":int(keep.sum()),"lens_off_displacement_p95":float(np.percentile(np.linalg.norm(target-source,axis=1)[keep],95)),"lens_off_affine_residual_p95":float(np.percentile(np.linalg.norm(target-prediction,axis=1)[keep],95))}
 result.append(row);print(row,flush=True)
(r/"result.json").write_text(json.dumps(result,indent=2)+"\n")
