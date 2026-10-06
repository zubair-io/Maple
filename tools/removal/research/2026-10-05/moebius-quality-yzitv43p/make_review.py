import json
from pathlib import Path

from PIL import Image, ImageDraw

r = Path(__file__).parent
notes = {
    4: "Wood: both models improve substantially at 512. Moebius is plausible but is not a decisive win over matched LaMa; native RAW enlargement still exposes the patch.",
    1: "Barrier: the original mask often produces a replacement person. The expanded mask improves removal but geometry/edge artifacts remain; inspect both seeds.",
    2: "Child: an uncovered strip of trouser fabric caused the dark streak in earlier tests. The expanded mask removes it; a faint fill boundary and texture differences remain.",
    3: "Rear person: the default initialization invents a pole or dark object. Corrected masks plus pure-noise initialization clear the person in both tested seeds; patch boundaries and texture continuity still need work. Switch Initialization to compare.",
    5: "Pedestrian: sash protection narrowed to remove the accidentally protected leg fragment. Better object coverage, but the generated region has a visible boundary. Manual mask still needs human review.",
}
style = """body{background:#15181b;color:#ecf0f1;font:16px system-ui;max-width:1400px;margin:auto;padding:28px}h1{font-size:34px}h2{font-size:25px}p{line-height:1.55;max-width:1050px;color:#c6cfd2}section{background:#20262b;border:1px solid #43505a;border-radius:14px;padding:22px;margin:22px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}#photographic .grid{grid-template-columns:repeat(4,minmax(0,1fr))}.viewport{overflow:auto;max-height:700px}img{width:100%;display:block}label{display:inline-block;margin:8px 10px 8px 0}button,select{padding:9px;background:#35464c;border:1px solid #718089;border-radius:7px;color:#fff;font:inherit}button{cursor:pointer}figcaption{padding:8px 0;color:#d4e5eb}.native img{width:auto;max-width:none}a{color:#83d9e8}.badge{color:#ffd196}small{color:#aebbc2}details{margin:16px 0}li{line-height:1.7}@media(max-width:750px){.grid,#photographic .grid{grid-template-columns:1fr}}"""
opts = "".join(
    f'<option value="{i}">{i} · {name}</option>'
    for i, name in [
        (4, "Die on wood"),
        (1, "Barrier"),
        (2, "Child"),
        (3, "Rear person"),
        (5, "Pedestrian / sash"),
    ]
)
parts = [
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Maple · Moebius quality tests</title><style>'
    + style
    + '</style><h1>Maple · Moebius quality tests</h1><p class="badge">Quality-first experiment · No shipping qualification</p><p>Moebius improves some fills, but is not a dependable replacement yet. Matched LaMa at 512 also improves sharply over the previous native-resolution trials. Mask errors caused some earlier artifacts; correcting them is part of this comparison.</p><p>The official Moebius checkpoint uses 512×512 input and fixed positional parameters. The same frozen scene crops are resized to 512 for both models. These results assess content quality; they do not establish full-resolution RAW detail.</p>'
]
parts.append(
    f"""<section id="photographic"><h2>Photographic comparison</h2><label>Photo <select id="case" onchange="updatePhoto()">{opts}</select></label><label>Mask <select id="mask" onchange="updatePhoto()"><option value="revised">Expanded / corrected</option><option value="original">Original (diagnostic)</option></select></label><label>Initialization <select id="strength" onchange="updatePhoto()"><option value="standard">Published default (0.99)</option><option value="full">Pure noise (1.0), barrier/rear-person only</option></select></label><button onclick="this.closest('section').classList.toggle('native')">Fit / 512 pixels</button><button onclick="toggleOverlay()">Source / Selection</button><p id="assessment"></p><small id="scope"></small><div class="grid">"""
)
for name, title in [
    ("source", "Input"),
    ("lama", "LaMa · same resolution and mask"),
    ("mo0", "Moebius · seed 0"),
    ("mo1", "Moebius · seed 1"),
]:
    parts.append(
        f'<div><figcaption>{title}</figcaption><div class="viewport"><img id="{name}" alt="{title}"></div></div>'
    )
parts.append(
    '</div></section><section id="raw"><h2>Actual RAW develop checks</h2><p>512 generation → bilinear enlargement to a 2048 native context → existing inverse and fp16 patch codec → Maple develop. This deliberately includes a resize-only control to show detail lost even without generation. Auto/Neutral, ±3 EV and ±1000 K are available. The corrected child mask is the main comparison; earlier tests remain in the local evidence.</p><label>RAW case <select id="rawcase" onchange="updateRaw()"><option value="32">Child · corrected mask · +2 EV model input</option><option value="14">Wood · original mask · 0 EV model input</option><option value="12">Child · original mask (confounded)</option></select></label><label>Profile <select id="profile" onchange="updateRaw()"><option value="auto">Auto</option><option value="neutral">Neutral</option></select></label><label>Exposure <select id="ev" onchange="updateRaw()"><option value="+0">0 EV</option><option value="-3">−3 EV</option><option value="+3">+3 EV</option></select></label><label>WB delta <select id="wb" onchange="updateRaw()"><option value="+0">0 K</option><option value="-1000">−1000 K</option><option value="+1000">+1000 K</option></select></label><label>Fourth panel <select id="control" onchange="updateRaw()"><option value="resize">Resize-only control</option><option value="identity">Identity control (no resizing)</option></select></label><button onclick="this.closest(\'section\').classList.toggle(\'native\')">Fit / Native pixels</button><div class="grid">'
)
for name, title in [
    ("rawsource", "Original, same grade"),
    ("rawmo", "Moebius seed 0, same grade"),
    ("rawlama", "LaMa, same grade"),
    ("rawcontrol", "Control, same grade"),
]:
    parts.append(
        f'<div><figcaption>{title}</figcaption><div class="viewport"><img id="{name}" alt="{title}" loading="lazy"></div></div>'
    )
parts.append(
    """</div></section><details><summary>Protocol and limits</summary><ul><li>Pinned official Moebius ft_places2, float32 PyTorch/MPS; strict learned-weight loading. Published sampling: 20 requested steps, strength 0.99 (19 effective steps), CFG 2.5, noise offset 0.0357. Seeds 0 and 1.</li><li>Pure-noise controls use strength 1.0 and 20 effective steps. An MPS scheduler-device correction is recorded; no learned parameters were changed.</li><li>Masks are assistant-prepared and visually reviewed, not human-approved ground truth. Expanded variants fill concave gaps and add a four-pixel selection margin at model resolution.</li><li>Source pixels outside coverage and protected sash pixels are checked exactly. Private photos and outputs remain local.</li><li>Timing/RSS are observational. Some runs overlap other work. They are not supported-device performance qualification.</li><li>Passing a model-quality trial would lead to RAW/detail and deployment qualification, not directly to shipping.</li></ul></details><p><a href="summary.json">Experiment results</a> · <a href="raw-verification.json">Initial RAW checks</a> · <a href="raw-mask-control-verification.json">Corrected RAW checks</a> · <a href="runtime-provenance.json">Runtime provenance</a> · <a href="source-integrity.json">Original integrity</a> · <a href="https://github.com/hustvl/Moebius">Official Moebius source</a></p>"""
)
parts.append(
    "<script>const notes="
    + json.dumps(notes)
    + ';let overlay=false;function updatePhoto(){const i=Number(document.getElementById("case").value);const revised=document.getElementById("mask").value==="revised";const id=revised&&i!==5?i+20:i;const full=document.getElementById("strength").value==="full"&&[1,3].includes(i);const prefix="case-"+id+"/";document.getElementById("source").src=prefix+(overlay?"mask.png":"source.png");document.getElementById("lama").src=prefix+"lama-result.png";for(const seed of [0,1])document.getElementById("mo"+seed).src=prefix+"moebius-"+(full?"fullnoise-":"")+"seed"+seed+".png";document.getElementById("assessment").textContent=notes[i];document.getElementById("scope").textContent=(i===5?"Case 5 uses the revised sash mask in both mask modes.":(revised?"Expanded-mask control":"Original-mask baseline"))+" · 512 generated pixels · "+(full?"Pure noise, 20 steps":"Default, 19 effective steps");}function toggleOverlay(){overlay=!overlay;updatePhoto();}function updateRaw(){const folder="case-"+document.getElementById("rawcase").value+"/";const grade=document.getElementById("profile").value+"_ev"+document.getElementById("ev").value+"_wb"+document.getElementById("wb").value;document.getElementById("rawsource").src=folder+"moebius-seed0-grades/"+grade+"-truth.png";document.getElementById("rawmo").src=folder+"moebius-seed0-grades/"+grade+"-removal.png";document.getElementById("rawlama").src=folder+"lama-grades/"+grade+"-removal.png";document.getElementById("rawcontrol").src=folder+(document.getElementById("control").value==="resize"?"resize-control-grades/"+grade+"-removal.png":"moebius-seed0-grades/"+grade+"-identity.png");}updatePhoto();updateRaw();</script></html>'
)
(r / "index.html").write_text("\n".join(parts))
# Compact, labeled scientific comparison artifact; all panels resized equally for overview.
sheet = Image.new("RGB", (1024, 5 * 286), "#20262b")
draw = ImageDraw.Draw(sheet)
for row, i in enumerate([24, 21, 22, 23, 5]):
    for col, (file, label) in enumerate(
        [
            ("source.png", "Input"),
            ("lama-result.png", "LaMa 512"),
            ("moebius-seed0.png", "Moebius seed 0"),
            ("moebius-seed1.png", "Moebius seed 1"),
        ]
    ):
        draw.text(
            (col * 256 + 6, row * 286 + 8), f"Case {i % 20} · {label}", fill="white"
        )
        sheet.paste(
            Image.open(r / f"case-{i}" / file).resize((256, 256)),
            (col * 256, row * 286 + 30),
        )
sheet.save(r / "comparison-overview.png")
