#!/usr/bin/env python3
"""Per-luma-band tone-slider gate.

For a slider case, "effect" = mean ΔL* of a luma band between the case render
and the SAME renderer's baseline render. Bands are chosen on the baseline:
  top = pixels at or above the baseline's 95th percentile L*
  mid = pixels with baseline L* in (40, 60)
  bot = pixels at or below the baseline's 5th percentile L*
The gate compares Maple's effect with ACR's effect for the same fixture/case
and fails when |maple − acr| exceeds the per-band budget.

Usage:
  tone_band_gate.py measure BASELINE.png CASE.png
  tone_band_gate.py gate --candidates DIR --references ROOT --manifest M.json \
      --budgets B.json [--filter SUBSTR] [--write-acr OUT.json]
Candidates are maple-cli batch outputs: DIR/<fixture>_<case>.png.
References: ROOT/<fixture>/down/<case>.png (ACR renders).
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image

BANDS = ("top", "mid", "bot")


def lstar(path, size=None):
    im = Image.open(path).convert("RGB")
    if size is not None:
        im = im.resize(size, Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    y = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    return np.where(y > 0.008856, 116.0 * np.cbrt(y) - 16.0, 903.3 * y)


def measure(baseline_png, case_png):
    b = lstar(baseline_png)
    c = lstar(case_png, (b.shape[1], b.shape[0]))
    d = c - b
    top = b >= np.quantile(b, 0.95)
    mid = (b > 40.0) & (b < 60.0)
    bot = b <= np.quantile(b, 0.05)
    pick = lambda m: float(d[m].mean()) if m.any() else float("nan")
    return {"top": pick(top), "mid": pick(mid), "bot": pick(bot)}


def cases_from_manifest(manifest, flt):
    out = []
    for c in json.load(open(manifest))["cases"]:
        fixture, case = c["name"].split("/", 1)
        if case == "baseline" or not fixture.startswith("test_"):
            continue
        if flt and flt not in c["name"]:
            continue
        out.append((fixture, case))
    return out


def gate(args):
    budgets = json.load(open(args.budgets))
    acr_out, breaches, rows = {}, [], []
    for fixture, case in cases_from_manifest(args.manifest, args.filter):
        ref_base = os.path.join(args.references, fixture, "down", "baseline.png")
        ref_case = os.path.join(args.references, fixture, "down", f"{case}.png")
        cand_base = os.path.join(args.candidates, f"{fixture}_baseline.png")
        cand_case = os.path.join(args.candidates, f"{fixture}_{case}.png")
        if not all(map(os.path.exists, (ref_base, ref_case, cand_base, cand_case))):
            rows.append(f"skip  {fixture}/{case} (missing render or reference)")
            continue
        acr = measure(ref_base, ref_case)
        maple = measure(cand_base, cand_case)
        acr_out.setdefault(fixture, {})[case] = acr
        budget = budgets.get("fixtures", {}).get(fixture, {}).get(case)
        if budget is None:
            breaches.append(f"{fixture}/{case}: no-budget-entry")
        errs = {b: maple[b] - acr[b] for b in BANDS}
        line = " ".join(f"{b}:{maple[b]:+6.1f}/{acr[b]:+6.1f}" for b in BANDS)
        rows.append(f"{fixture}/{case:16s} {line}   (maple/acr ΔL*)")
        if budget is not None:
            for b in BANDS:
                if abs(errs[b]) > budget[b]:
                    breaches.append(f"{fixture}/{case}: {b} error {errs[b]:+.1f} > {budget[b]:.1f}")
    print("\n".join(rows))
    if args.write_acr:
        json.dump(acr_out, open(args.write_acr, "w"), indent=1, sort_keys=True)
    if breaches:
        print("\nBREACH:\n  " + "\n  ".join(breaches))
        return 1
    print("\ntone_band_gate: OK")
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("measure"); m.add_argument("baseline"); m.add_argument("case")
    g = sub.add_parser("gate")
    for name in ("--candidates", "--references", "--manifest", "--budgets"):
        g.add_argument(name, required=True)
    g.add_argument("--filter", default="")
    g.add_argument("--write-acr", default="")
    args = p.parse_args()
    if args.cmd == "measure":
        print(json.dumps(measure(args.baseline, args.case)))
        return 0
    return gate(args)


if __name__ == "__main__":
    sys.exit(main())
