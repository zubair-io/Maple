"""Build an all-image diagnostic review from an immutable qualification run."""

import argparse
import html
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

NOTES = {
    "test_0000": "Roof and road contrast/detail differ; inspect at the embedded preview resolution before interpreting sensor-resolution detail.",
    "test_0002": "Portrait broadly close at overview scale. Inspect skin and hair texture; numerical pass is not visual approval.",
    "test_0003": "Remaining differences concentrate near blue pavement/corners. Check geometry and color separately.",
    "test_0004": "Chart broadly close; inspect individual saturated patches and curtain shading.",
    "test_0005": "Sky/shadow mismatch. Confirmed reference defect: RAF embedded JPEG declares R03 Adobe RGB, but this checkpoint treated it as sRGB. These old scores are not valid color acceptance evidence.",
    "test_0006": "Uneven wall/counter brightness mismatch. A uniform exposure change would affect already-close areas.",
    "test_0007": "Larger wall/counter brightness mismatch than 0006. Spatial illumination is a hypothesis, not an established cause.",
    "test_0008": "Broad color match, with detail/framing differences around the package. Inspect lettering at matched preview resolution.",
    "test_0009": "Broad match in chart and sky; inspect saturated chart patches and gradients.",
    "test_0010": "Chart and foreground tonality still differ despite numerical pass; inspect the gray ramp separately.",
    "test_0011": "Broad match at overview scale; inspect dark foreground texture and sky gradient.",
    "test_0012": "Broad match after alignment; inspect building shadow contrast and sky.",
    "test_0013": "Broad match; inspect water/foreground contrast. Phone processing may be spatial, but this is not yet proven.",
    "test_0014": "Broad match; inspect tree and grass detail and shadow density.",
    "test_0015": "Largest visible haze/contrast mismatch: foliage shadows are lifted and clouds lack separation. Pixel 6 Pro preview; global versus spatial tone processing needs a causal stage comparison.",
    "test_0017": "Brick/window/grass contrast differs; remaining errors concentrate near lower corners. Review both aligned geometry and local tone.",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--scripts", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    import auto_profile_alignment as alignment
    import auto_profile_quality as quality

    summary = json.loads((args.checkpoint / "full-suite/summary.json").read_text())
    cases = sorted(
        [r for r in summary["cases"] if "quality" in r], key=lambda r: r["fixture"]
    )
    assert len(cases) == 16 and {r["fixture"] for r in cases} == set(NOTES)
    args.output.mkdir(exist_ok=True, parents=True)
    records, cards = [], []
    for row in cases:
        name = row["fixture"]
        folder = args.checkpoint / "full-suite" / name
        candidate, reference = quality.load_display_pair(
            folder / "auto.png", folder / "embedded.png"
        )
        warp = np.array(
            row["quality"]["alignment"]["candidate_to_reference_normalized"]
        )
        aligned, valid = alignment.resample_reference(reference, warp)
        y_ref = aligned @ np.array([0.2126, 0.7152, 0.0722])
        y_auto = candidate @ np.array([0.2126, 0.7152, 0.0722])
        bands = []
        for lo, hi in [(0, 0.1), (0.1, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.001)]:
            mask = valid & (y_ref >= lo) & (y_ref < hi)
            bands.append(
                {
                    "reference_luma_band": [lo, hi],
                    "pixels": int(mask.sum()),
                    "auto_minus_reference_luma": float(
                        (y_auto[mask] - y_ref[mask]).mean()
                    )
                    if mask.any()
                    else None,
                }
            )
        record = {
            "fixture": name,
            "numerical_status": row["status"],
            "visual_approval": False,
            "observation": NOTES[name],
            "candidate_sha256": row["candidate_sha256"],
            "reference_sha256": row["reference_sha256"],
            "comparison_size": list(candidate.shape[1::-1]),
            "aligned_valid_fraction": float(valid.mean()),
            "signed_luma_by_band": bands,
            "reference_color_space_audit": "incorrect Adobe RGB interpretation at this checkpoint"
            if name == "test_0005"
            else "no confirmed defect; independent audit ongoing",
        }
        records.append(record)
        for key, pixels in [("auto", candidate), ("reference", aligned)]:
            display = np.where(valid[:, :, None], pixels, 0.18)
            Image.fromarray(np.rint(np.clip(display, 0, 1) * 255).astype("uint8")).save(
                args.output / f"{name}-{key}.png"
            )
        cards.append(f'''<section id="{name}"><h2>{name} · numerical {row["status"]}</h2>
<p>{html.escape(NOTES[name])}</p><div class="pair"><figure><figcaption>Current Auto</figcaption><img src="{name}-auto.png"></figure><figure><figcaption>Embedded preview · aligned coordinates</figcaption><img src="{name}-reference.png"></figure></div>
<p><a href="{(args.checkpoint / "gallery/index.html").as_uri()}#{name}">Open full-size original switching</a> · {candidate.shape[1]} × {candidate.shape[0]} comparison · outside overlap shown gray.</p></section>''')
    (args.output / "review.json").write_text(json.dumps(records, indent=2) + "\n")
    page = """<!doctype html><meta charset="utf-8"><title>Auto: visual diagnosis across all 16 images</title><style>body{max-width:1500px;margin:30px auto;padding:0 20px;background:#202124;color:#eee;font:17px system-ui}a{color:#9bcaff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0}img{width:100%}section{margin:48px 0}figcaption{margin:8px 0}.notice{padding:18px;background:#543a20}</style><h1>Visual diagnosis — all 16 images</h1><p class="notice">Diagnostic review, not visual approval. Frozen CPU checkpoint 8eff5491e1: 9 numerical passes and 7 failures, plus 4 separate previewless fallback checks. Test 0005 has a confirmed reference color-space defect. This page introduces no new rendering or relaxed thresholds.</p><p>Both panels use the existing measurement resolution and saved alignment. Only the reference coordinates are warped; no exposure, white balance, or color matching is applied. Original full-size switching remains available; its native images are not geometrically registered, and the embedded preview may be much smaller than the RAW.</p>"""
    (args.output / "index.html").write_text(page + "".join(cards))
    print(args.output / "index.html")


if __name__ == "__main__":
    main()
