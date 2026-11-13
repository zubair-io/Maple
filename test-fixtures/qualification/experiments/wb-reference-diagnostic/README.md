# Tint reference mismatch diagnostic

The captured-main renderer and canonical numerical budgets are unchanged.
The audit found that all 36 existing tint endpoint PNGs record effective tint
+10, while their canonical XMPs author -150 or +150. Two also record a different
explicit temperature. This is direct saved-setting evidence, not an inference
from color error or a reason to tune the renderer toward the wrong setting.

For test_0007, Photoshop/ACR rendered an isolated RAW copy using the existing
reference generator. Both missing temperatures were completed from that photo's
recorded As Shot baseline (3750 K), retaining each authored tint endpoint.
The new PNGs passed the complete effective-settings verifier. The original
RAW, canonical sidecars, baseline and two canonical PNG hashes remain unchanged.
No canonical reference was replaced. The diagnostic captures are retained locally
under `/Users/riabuz/.codex/color-suite-evidence/5000/wb-reference-diagnostic`.

Against the original captures, main fails both cases. Against the independently
verified diagnostic captures and identical budgets, tint_max passes (mean
6.81952 versus 50.04708 originally); tint_min still fails maximum error
47.98195 > 43.2, despite mean improving from 18.35168 to 4.51157. This exposes
remaining renderer error rather than hiding it. These alternate-reference
measurements are **not** counted as cleared canonical suite failures.

`identity.json` records original and diagnostic hashes and prepared settings;
`results.json` records both comparisons in full. The diagnostic does not grant
permission to replace canonical inputs or loosen budgets.
