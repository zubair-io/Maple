"""Render recorded observations next to the comparison assets."""

from common import ROOT, write_json

findings = {
    "scope": "Three supplied RAW scenes, fixed +16 masks and fixed LaMa/Qwen seed-0 coarse predictions. Qualitative unblinded review; no hidden-background truth.",
    "verdict": "No native-resolution method is qualified. RGB-guided texture transfer is the more promising of the two tested refiners; this diffusion configuration is rejected.",
    "cases": [
        {
            "case": 4,
            "scene": "Wood",
            "finding": "RGB-guided texture transfer replaces part of the soft patch with native donor grain, but residual softness/texture continuity need 100% review. Diffusion introduces a visibly smoother region and edges with both coarse models; it does not recover convincing grain.",
        },
        {
            "case": 2,
            "scene": "Indoor floor",
            "finding": "Texture transfer adds stone texture and changes the coarse wall/floor reconstruction, but tonal/structural remnants remain. Diffusion creates a conspicuous pale mask-shaped region. This was already a flawed coarse fill, so the result is a stress test, not evidence that refinement can rescue failed structure.",
        },
        {
            "case": 1,
            "scene": "Railing",
            "finding": "Texture transfer carries more local source texture but repeats/changes railing structure. Diffusion softens or erases railing content and changes the patch tone. Neither establishes trustworthy architectural continuation.",
        },
    ],
    "interpretation": "Do not equate sharper texture or unchanged outside pixels with photographic correctness. Generic low-strength tiled diffusion under this one checkpoint/setting failed; that does not rule out a dedicated super-resolution/refinement model. The PatchMatch variant uses RGB guidance only and is not the published depth/segmentation-guided method.",
    "nextDecision": "Retain both coarse models. Review the native crops before selecting a new refinement test. A narrower donor-selection/structure-guidance experiment is better supported by these outputs than adopting this generic diffusion pass.",
    "sources": [
        "https://arxiv.org/abs/2208.03552",
        "https://multidiffusion.github.io/",
    ],
    "releaseQualified": False,
}
write_json(ROOT / "findings.json", findings)
html = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native detail findings</title><style>body{font:16px system-ui;line-height:1.6;max-width:1200px;margin:40px auto;padding:0 20px;background:#191a1b;color:#eee}a{color:#8ac8ff}img{width:100%;height:auto}h1{line-height:1.2}p{max-width:1000px}</style><h1>Native detail: completed comparison</h1><p><a href="./">Open interactive comparison</a> · <a href="summary.json">Validation record</a></p>"""
html += f"<p><strong>{findings['verdict']}</strong></p><p>{findings['scope']}</p>"
for case in findings["cases"]:
    html += f'<h2>{case["scene"]}</h2><p>{case["finding"]}</p><p>Rows: LaMa, Qwen. Columns: bilinear enlargement, RGB-guided texture transfer, shared-latent diffusion.</p><img src="review/case-{case["case"]}-auto_ev+0_wb+0.jpg" alt="{case["scene"]} six-result comparison under Auto">'
html += f"<h2>What this establishes</h2><p>{findings['interpretation']}</p><p>{findings['nextDecision']}</p>"
html += """<p>18 main outputs plus 6 VAE controls. Full validation details and limitations are in the linked record. Tests check originals, frozen inputs, final coverage/protection, and RAW Auto/Neutral exposure/WB variants. Those checks are not a visual pass.</p><p>Method references: <a href="https://arxiv.org/abs/2208.03552">Guided PatchMatch</a> and <a href="https://multidiffusion.github.io/">MultiDiffusion</a>. This experiment implements limited mechanisms inspired by these approaches, not complete reproductions.</p></html>"""
(ROOT / "report.html").write_text(html)
