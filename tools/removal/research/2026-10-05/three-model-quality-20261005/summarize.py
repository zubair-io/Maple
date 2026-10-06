import hashlib
import html
import json
import statistics
from collections import defaultdict
from pathlib import Path

r = Path(__file__).parent
load = lambda p: json.loads(p.read_text())
checks = load(r / "model-verification.json")
assert len(checks) == 90, len(checks)
assert all(
    x["finiteModelSamples"]
    and x["nativeOutsideCoverageChanged"] == 0
    and x["nativeProtectedChanged"] == 0
    for x in checks.values()
)
sets = [load(p) for p in (r / "raw").glob("case-*/*/*-grades/verification.json")]
assert len(sets) == 48, len(sets)
assert all(
    len(x["grades"]) == 18
    and all(g["outsideCoverageChangedPixels"] == 0 for g in x["grades"])
    for x in sets
)
integrity = load(r / "source-integrity.json")
assert len(integrity) == 5 and all(x["unchanged"] for x in integrity)
rows = []
groups = defaultdict(list)
for path in checks:
    p = r / path
    d = load(p)
    parts = Path(path).parts
    mode = "raw" if parts[0] == "raw" else "photo"
    model = p.stem.split("-")[0]
    side = int(p.parent.name)
    row = {
        "path": path,
        "mode": mode,
        "model": model,
        "side": side,
        "seconds": d["inferenceSeconds"],
        "peakRSSBytes": d["peakRSSBytes"],
        "seed": d.get("seed"),
    }
    rows.append(row)
    groups[(mode, model, side)].append(row)
timing = []
for (mode, model, side), g in sorted(groups.items()):
    t = [x["seconds"] for x in g]
    timing.append(
        {
            "mode": mode,
            "model": model,
            "side": side,
            "n": len(g),
            "minSeconds": min(t),
            "medianSeconds": statistics.median(t),
            "maxSeconds": max(t),
            "processHighWaterRSSGiB": max(x["peakRSSBytes"] for x in g) / 2**30,
        }
    )
notes = load(r / "visual-notes.json")
assert notes.get("rawReviewComplete")
summary = {
    "complete": True,
    "experiment": "Three-model object removal quality comparison",
    "issue": 3941,
    "generations": 90,
    "photographicGenerations": 45,
    "rawPlateGenerations": 45,
    "rawGradeSets": 48,
    "rawRenderPreservationChecks": 864,
    "generatedPatchRenderChecks": 648,
    "resizeControlRenderChecks": 216,
    "identityPerceptualChecks": 72,
    "unmodifiedSourceIntegrity": load(r / "source-integrity.json"),
    "modelVerificationPass": True,
    "nativeOutsideCoverageChanges": 0,
    "nativeProtectedChanges": 0,
    "timing": timing,
    "timingCaveat": "Concurrent CPU grading; separate CPU LaMa and MLX GPU runtimes. Observational durations, not a controlled benchmark. RSS is lifetime process high-water mark, not isolated per-generation memory.",
    "controls": load(r / "control-summary.json"),
    "visualNotes": notes,
    "protocol": load(r / "protocol.json"),
    "productionQualified": False,
}
(r / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
esc = html.escape
trs = "".join(
    f"<tr><td>{x['mode']}</td><td>{x['model']}</td><td>{x['side']}</td><td>{x['n']}</td><td>{x['medianSeconds']:.2f}</td><td>{x['minSeconds']:.2f}–{x['maxSeconds']:.2f}</td><td>{x['processHighWaterRSSGiB']:.2f}</td></tr>"
    for x in timing
)
caseRows = "".join(
    f"<tr><td>{i}</td>"
    + "".join(
        f"<td>{esc(notes['cases'][str(i)][m])}</td>" for m in ["lama", "klein", "qwen"]
    )
    + "</tr>"
    for i in range(1, 6)
)
rawRows = "".join(
    f"<tr><td>{i}</td>"
    + "".join(
        f"<td>{esc(notes['rawCases'][str(i)][m])}</td>"
        for m in ["lama", "klein", "qwen"]
    )
    + "</tr>"
    for i in range(1, 5)
)
report = (
    """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maple removal experiment — results</title><style>body{background:#151916;color:#eee;font:16px/1.6 system-ui;max-width:1200px;margin:40px auto;padding:0 24px}a{color:#a1e4b2}h1{line-height:1.2}h2{margin-top:38px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #445046;padding:12px;text-align:left;vertical-align:top}th{background:#29352c}.lead{font-size:21px;color:#d3e7d6}.box{background:#253028;padding:18px;border-radius:8px}code{overflow-wrap:anywhere}img{max-width:100%}</style>
<h1>Maple AI removal: three-model experiment</h1><p>5 October 2026 · <a href="/">Open interactive comparison</a> · <a href="summary.json">Machine-readable results</a> · <a href="protocol.json">Frozen protocol</a></p>
<p class="lead">LaMa remains the most consistent baseline for people removal in this small set. The tested Klein and Qwen recipes do not establish a consistent quality improvement, although Qwen gives a useful improvement on the RAW wood case. Keep the improved photographic-input approach and address native detail and seams before production integration.</p>
<div class="box"><strong>Completed:</strong> 90 generations: 45 from camera-rendered photos and 45 independently from Maple RAW model-input plates. LaMa: 512/768/1024. FLUX.2 Klein 4B: 512/1024, seeds 0/1. Qwen Image Edit 2511: 512, seeds 0/1, full 40-step base model. All outputs retained.</div>
<h2>What the comparison supports</h2><p>Resolution is a quality tradeoff, not a rule that filling works only at low resolution. Here, 512/768 often produce more coherent large fills than the rejected earlier native-resolution attempts; 768/1024 sometimes keep more wood texture. An upsampled fill still lacks original sensor detail. This experiment does not isolate the cause of every improvement over the old tests: masks, plate encoding and inference method also changed.</p>
<p>These are assistant visual observations, not blind human scores or hidden-background ground truth. Rankings apply to these checkpoint/runtime/prompt/mask recipes, not every possible use of each model.</p>
<h2>Photographic results</h2><table><tr><th>Case</th><th>LaMa</th><th>Klein</th><th>Qwen</th></tr>"""
    + caseRows
    + """</table>
<h2>RAW develop results</h2><p>Four calibrated cases were baked through the Rust patch codec and develop path at Auto/Neutral × exposure −3/0/+3 EV × WB −1000/0/+1000 K. Visual review sampled baseline and stress grades, including native views; automated preservation checks covered all 18 grades per set. Very dark negative-exposure views are not useful proof of texture quality.</p><table><tr><th>Case</th><th>LaMa</th><th>Klein</th><th>Qwen</th></tr>"""
    + rawRows
    + """</table>
<p>Case 5 has all model-input plate and photographic results, but calibrated RAW/WB development is unavailable: <a href="https://github.com/zubair-io/Maple/issues/4283">Canon EOS Kiss M calibration #4283</a>. No substitute camera profile was used.</p>
<h2>Integrity and controls</h2><ul><li>All 90 model predictions finite; compositing changes zero pixels outside coverage or inside protected areas.</li><li>864 RAW render preservation checks passed: 648 generated-patch grades and 216 resize-control grades. These are integrity checks, not 864 visual quality passes.</li><li>All five original RAW hashes unchanged.</li><li>72 identity round-trip ROI measurements: worst mean ΔE2000 0.0401. 216 resize-only ROI measurements: worst mean ΔE2000 4.7749. These quantify harness loss, not generated-background quality.</li><li>14 Rust research-probe tests passed; no hard file-budget violation and no whitespace errors. Production pipeline/UI unchanged.</li></ul>
<p>The fixed AgX/sRGB inverse remains experimental: a small identity error on these selected pixels does not prove recovery of clipped, compressed or out-of-gamut scene information. Model plates use identical 8-bit quantization within each mode. Camera and RAW modes use different coverage feather recipes; their differences cannot all be assigned to encoding.</p>
<h2>Recorded runtime</h2><p>Apple M5 Max, 128 GiB unified memory. LaMa CPU float32; Klein/Qwen 8-bit converted weights on MLX GPU. Concurrent CPU grading means these are observations, not comparative performance qualification. RSS is process lifetime high-water memory, including retained runtime allocations.</p><table><tr><th>Input</th><th>Model</th><th>Side</th><th>Runs</th><th>Median seconds</th><th>Range seconds</th><th>RSS high-water GiB</th></tr>"""
    + trs
    + """</table>
<p>Qwen 1024 was interrupted during an early timing probe; there is no completed 1024 quality result. Full 40-step Qwen quality trials were completed at 512. Performance was recorded rather than used as the go/no-go gate.</p>
<h2>What to do next</h2><ol><li>Use the gallery to choose acceptable LaMa results at native size and identify the unacceptable seam/detail cases.</li><li>Test a bounded refinement of context, mask boundary and photographic plate handling against those failures, preserving the same control images. Avoid another broad UI implementation before this improves.</li><li>Resolve scene reconstruction and camera calibration, then qualify on a larger held-out set and the actual Mac runtime before rebuilding the feature.</li></ol>
<p>No Core ML deployment, production UI integration, GPU parity, export qualification or universal RAW-color guarantee is claimed by this experiment. The experiment is complete; <a href="https://github.com/zubair-io/Maple/issues/3941">research issue #3941</a> and the feature remain open.</p>
<h2>Reproducibility</h2><p><a href="harness-provenance.json">Harness provenance</a> · <a href="model-verification.json">Per-model verification</a> · <a href="source-integrity.json">Source integrity</a> · <a href="visual-notes.json">Visual notes</a> · <a href="control-summary.json">Control metrics</a></p>
<p>Runtime: <a href="https://github.com/lpalbou/mlx-gen/tree/99fb94dd3eaa9dd1931cd3cd8eae1ae3e20f2ef3">pinned mlx-gen</a>. Klein: <a href="https://huggingface.co/AbstractFramework/flux.2-klein-4b-8bit/tree/21764997c7d92ab919d4a51a3ac7f8fb0f36c4a6a">8-bit checkpoint</a>. Qwen: <a href="https://huggingface.co/AbstractFramework/qwen-image-edit-2511-8bit/tree/5f35885dfe4061e57c87df2c03123e5e8124edfa">8-bit checkpoint</a>; <a href="https://huggingface.co/Qwen/Qwen-Image-Edit-2511">official model card</a>. Model payload hashes, prompts, seeds, steps and strict-load diagnostics are saved locally.</p></html>"""
)
# Use the actual manifest revision for the checkpoint link.
km = load(r / "klein-manifest.json")
report = report.replace("21764997c7d92ab919d4a51a3ac7f8fb0f36c4a6a", km["revision"])
(r / "report.html").write_text(report)
files = [
    p
    for p in r.iterdir()
    if p.suffix in (".py", ".html", ".json", ".patch")
    and p.name != "artifact-digests.json"
]
(r / "artifact-digests.json").write_text(
    json.dumps(
        {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)},
        indent=2,
    )
    + "\n"
)
print(
    json.dumps(
        {"generations": 90, "RAW_render_checks": 864, "report": str(r / "report.html")}
    )
)
