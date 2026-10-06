import html
import json
from pathlib import Path

r = Path(__file__).parent
cases = json.loads((r / "cases.json").read_text())
notes = [
    "Person removed, but the barrier lines break and bend. Quality rejected.",
    "Most promising at a glance. At native scale, wall/floor texture blurs into a vertical patch and the boundary line weakens. Not accepted.",
    "Large person-shaped blur and missing architectural detail. Quality rejected.",
    "Die removed, but a conspicuous gray patch replaces the wood grain. Quality rejected.",
    "Smeared background. A protection polygon also covers part of the unwanted person near the sash, leaving a fragment. Mask-confounded; not a clean model-only verdict.",
]
css = """body{background:#161819;color:#ecebea;font:16px system-ui;margin:auto;max-width:1400px;padding:32px}h1{font-size:36px}h2{margin-top:0}p{max-width:950px;line-height:1.55;color:#c4c9cb}section{background:#202427;border:1px solid #3d4448;border-radius:16px;padding:24px;margin:24px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.viewport{overflow:auto;max-height:720px;background:#111}img{display:block;width:100%;height:auto}.native img{width:auto;max-width:none}button,select{background:#39464b;color:white;border:1px solid #687479;padding:9px 14px;border-radius:8px;margin:8px 8px 12px 0}button{cursor:pointer}small{color:#aab4b8}a{color:#8ed6da}label{display:block;margin-bottom:8px}.badge{color:#ffc889}@media(max-width:700px){.pair{grid-template-columns:1fr}}"""
parts = [
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Maple removal quality experiment</title><style>'
    + css
    + '</style><h1>Maple · Removal quality experiment</h1><p class="badge">Quality first · Local results · No result approved for shipping</p><p>Five supplied RAWs, one frozen Big-LaMa forward pass per test, native pixels without resizing. The first five comparisons use each RAW’s full-resolution embedded camera JPEG to isolate photographic fill quality. The RAW checks below use Maple’s actual scene-linear pipeline. Masks were drawn and inspected by the assistant, not independently approved ground-truth masks.</p><p>Choose “Native pixels” to inspect without fitting the crop to its panel. Timings and peak process memory are observations, not acceptance gates. Original RAWs and sidecars were never written.</p>'
]
for c, note in zip(cases, notes):
    i = c["id"]
    report = json.loads((r / f"case-{i}/lama-report.json").read_text())
    name = html.escape(Path(c["raw"]).name)
    parts.append(
        f"""<section id="case-{i}"><h2>{i}. {html.escape(c["target"])}</h2><small>{name} · {c["window"][2]} × {c["window"][3]} native crop · {report["inferenceSeconds"]:.1f}s inference · {report["processPeakRSSBytes"] / 2**30:.1f} GiB process peak</small><p>{note}</p><button onclick="this.closest('section').classList.toggle('native')">Fit / Native pixels</button><button onclick="toggleMask(this,{i})">Show / Hide selection</button><div class="pair"><div><label>Camera-rendered source / mask</label><div class="viewport"><img class="before" src="case-{i}/source.png" alt="Case {i} source" loading="lazy"></div></div><div><label>LaMa removal</label><div class="viewport"><img src="case-{i}/lama-result.png" alt="Case {i} generated result" loading="lazy"></div></div></div></section>"""
    )
parts.append(
    "<h1>RAW adjustment checks</h1><p>Native As-Shot post-DCP scene → fixed AgX/sRGB input → LaMa → approximate inverse → actual fp16 patch codec → Maple develop chain. Auto/Neutral, −3/0/+3 EV and −1000/0/+1000 K: 18 grades per configuration. “Identity” sends the unmodified model input through the same inverse and storage path. Original is a comparison control, not ground truth for the hidden background. The +2 EV variant brightens only the model input and reverses that gain before compositing.</p>"
)
for index, relative in enumerate(
    ["case-1/grades", "case-2/grades", "case-2/grades-plus2"]
):
    options = "".join(
        f'<option value="{profile}_ev{ev:+}_wb{wb:+}" '
        + ("selected" if (profile, ev, wb) == ("auto", 0, 0) else "")
        + f">{profile.title()} · {ev:+} EV · {wb:+} K</option>"
        for profile in ["auto", "neutral"]
        for ev in [-3, 0, 3]
        for wb in [-1000, 0, 1000]
    )
    parts.append(
        f'''<section data-folder="{relative}"><h2>{relative.replace("/", " · ")}</h2><select class="grade" aria-label="RAW grade" onchange="updateGrade(this)">{options}</select><select class="mode" aria-label="Comparison output" onchange="updateGrade(this)"><option value="removal">Removal</option><option value="identity">Identity control</option></select><button onclick="this.closest('section').classList.toggle('native')">Fit / Native pixels</button><div class="pair"><div><label>Original, same grade</label><div class="viewport"><img class="truth" src="{relative}/auto_ev+0_wb+0-truth.png" loading="lazy" alt="Original RAW grade"></div></div><div><label>Selected output, same grade</label><div class="viewport"><img class="result" src="{relative}/auto_ev+0_wb+0-removal.png" loading="lazy" alt="Reconstructed RAW grade"></div></div></div></section>'''
    )
parts.append("""<p><a href="results.json">Machine-readable experiment summary</a> · <a href="identity-metrics.json">54 RAW identity measurements</a> · <a href="source-integrity.json">Original-file integrity</a></p><script>
function toggleMask(button,id){const im=button.closest('section').querySelector('.before');im.src=im.src.includes('mask-review')?`case-${id}/source.png`:`case-${id}/mask-review.png`;}
function updateGrade(control){const section=control.closest('section');const prefix=section.dataset.folder+'/'+section.querySelector('.grade').value;section.querySelector('.truth').src=prefix+'-truth.png';section.querySelector('.result').src=prefix+'-'+section.querySelector('.mode').value+'.png';}
</script>""")
(r / "index.html").write_text("\n".join(parts))
summary = {
    "scope": "Local quality-first experiment; performance recorded, not a rejection gate",
    "model": "Pinned frozen Big-LaMa, float32 CPU, single forward pass, no optimizer",
    "nativeResolution": True,
    "originalsModified": False,
    "cameraJpegTrials": [
        dict(
            assessment=n,
            **json.loads((r / f"case-{i + 1}/lama-report.json").read_text()),
        )
        for i, n in enumerate(notes)
    ],
    "rawTrials": [
        {"configuration": p, "report": json.loads((r / p / "report.json").read_text())}
        for p in ["case-1/grades", "case-2/grades", "case-2/grades-plus2"]
    ],
    "qualification": "No photographic pass. This does not prove all models or smaller distractions infeasible. Graduation case has a known manual-mask confound. No ACR, GPU/Web parity or Mac UI qualification claimed.",
}
(r / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
