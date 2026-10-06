"""Write local comparison viewer; saved assets remain separate from source."""

import json

import numpy as np
from common import CASES, ROOT, load

centers = {}
for case in CASES:
    _, _, _, cov, _, _, _ = load(case, "lama")
    ys, xs = np.nonzero(cov > 0)
    centers[case] = [float((xs.min() + xs.max()) / 2), float((ys.min() + ys.max()) / 2)]

(ROOT / "index.html").write_text(
    """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maple — Native detail experiment</title>
<style>body{font:15px system-ui;background:#191a1b;color:#eee;margin:24px}h1{font-size:26px;margin-bottom:8px}p{max-width:1100px;line-height:1.55;color:#ccc}a{color:#8ac8ff}label{display:inline-block;margin:8px 16px 8px 0}select,button{background:#303235;color:white;border:1px solid #666;padding:9px;border-radius:6px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.panel{background:#242628;padding:12px;border-radius:10px;min-width:0}.viewport{overflow:auto;height:65vh;background:#101112}.viewport img{display:block;width:100%;height:auto}.native img{width:auto;max-width:none}h2{font-size:17px}.notice{color:#ffc98c}#progress{font-size:13px}details{margin:16px 0} @media(max-width:950px){main{grid-template-columns:1fr}.viewport{height:55vh}}</style>
<h1>From a 512 fill to a native-size patch</h1><p>Same saved LaMa or Qwen fill, same expanded mask, three reconstruction methods. The diffusion refiner is a shared SD1.5-family model for both starting fills. This is a research comparison, not a finished removal feature.</p>
<p><a href="../mask-expansion/">Previous mask test</a> · <a href="protocol.json">Protocol</a> · <a href="refiner-provenance.json">Refiner provenance</a> · <a href="report.html">Findings</a></p>
<label>Scene <select id="scene"><option value="4">Wooden table</option><option value="2">Indoor floor — stress case</option><option value="1">Outdoor railing</option></select></label>
<label>Starting fill <select id="model"><option value="lama">LaMa</option><option value="qwen-seed0">Qwen</option></select></label>
<label>Develop <select id="profile"><option value="auto">Auto</option><option value="neutral">Neutral</option><option value="plate">Inference RGB plate</option></select></label>
<label>Exposure <select id="ev"><option value="+0">0 EV</option><option value="-3">−3 EV</option><option value="+3">+3 EV</option></select></label>
<label>White balance <select id="wb"><option value="+0">Original</option><option value="-1000">−1000 K</option><option value="+1000">+1000 K</option></select></label>
<label>View <select id="zoom"><option value="fit">Fit</option><option value="native">100% — one source pixel per CSS pixel</option></select></label>
<button id="focus" type="button">Center removal at 100%</button><button id="original" type="button">Show original</button><button id="vae" type="button">Show VAE control in third panel</button>
<p class="notice">The floor starting fills already have tonal/structural defects. Added sharpness alone does not count as a successful repair. 100% follows source pixels; browser zoom and display scaling affect physical pixels.</p><p id="progress">Checking saved results…</p>
<main><section class="panel"><h2>1 · Plain enlargement</h2><div class="viewport"><img alt="Bilinear enlargement" id="bilinear"></div></section><section class="panel"><h2>2 · Guided texture transfer</h2><div class="viewport"><img alt="RGB-guided native source texture transfer" id="patchmatch"></div></section><section class="panel"><h2 id="third">3 · Shared-latent diffusion</h2><div class="viewport"><img alt="Low-strength shared-latent diffusion refinement" id="diffusion"></div></section></main>
<details><summary>How to read this test</summary><p>Texture transfer copies native source patches using the coarse RGB fill as a guide. It is a limited translation-only PatchMatch prototype, without depth or semantic guidance. Diffusion starts from the same enlarged coarse fill with 25% denoising strength, uses 512-pixel windows with at least 128-pixel overlap, fuses predictions into one latent canvas every step, and reanchors known latents. The VAE control only encodes/decodes the starting image.</p><p>All methods use identical final replacement coverage and protected pixels. RAW Auto/Neutral grades test exposure and white-balance behavior through the existing experimental conversion. Pixel-preservation checks do not establish quality inside the fill or recover hidden sensor data.</p></details>
<script>
const $=id=>document.getElementById(id);let original=false,vae=false,lock=false;const centers=__CENTERS__;
function draw(){const c=$('scene').value,m=$('model').value,p=$('profile').value;document.querySelectorAll('.viewport').forEach(e=>e.classList.toggle('native',$('zoom').value==='native'));
for(const id of ['bilinear','patchmatch','diffusion']){const method=id==='diffusion'&&vae?'vae-control':id;let path=`case-${c}/${m}/${method}.png`;if(p!=='plate')path=`case-${c}/${m}/${method}-grades/${p}_ev${$('ev').value}_wb${$('wb').value}-${original?'truth':'removal'}.png`;else if(original)path=`case-${c}/source.png`;
$(id).src=path;$(id).onerror=()=>{$(id).alt='Result still being prepared — refresh shortly';};}
$('vae').textContent=vae?'Show diffusion in third panel':'Show VAE control in third panel';$('diffusion').alt=vae?'Encoding-only control':'Shared-latent diffusion refinement';$('original').textContent=original?'Show removal':'Show original';$('third').textContent=vae?'3 · VAE encode/decode control':'3 · Shared-latent diffusion';}
$('focus').onclick=()=>{$('zoom').value='native';draw();requestAnimationFrame(()=>{const [x,y]=centers[$('scene').value];document.querySelectorAll('.viewport').forEach(v=>{v.scrollLeft=x-v.clientWidth/2;v.scrollTop=y-v.clientHeight/2;});});};
document.querySelectorAll('select').forEach(e=>e.addEventListener('change',draw));$('original').onclick=()=>{original=!original;draw();};$('vae').onclick=()=>{vae=!vae;draw();};
document.querySelectorAll('.viewport').forEach(v=>v.addEventListener('scroll',()=>{if(lock)return;lock=true;document.querySelectorAll('.viewport').forEach(o=>{if(o!==v){o.scrollLeft=v.scrollLeft;o.scrollTop=v.scrollTop;}});requestAnimationFrame(()=>lock=false);}));
async function progress(){try{const b=await fetch('bake-progress.json',{cache:'no-store'}).then(r=>r.json());$('progress').textContent=`RAW validation: ${b.completedSets}/${b.totalSets} image sets, ${b.checks} preservation checks. Includes 18 comparison outputs and 6 VAE controls.`;}catch{}}
draw();progress();setInterval(progress,10000);
</script></html>""".replace("__CENTERS__", json.dumps(centers))
)
print(ROOT / "index.html")
