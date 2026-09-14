# Exposure response corpus (#3631)

Six actual Adobe Camera Raw renders protect the meaning of Exposure at -1, 0,
and +1 EV on the two fixtures that showed the strongest positive Auto response.
The RAW multiplier stays exactly `2^EV`; this corpus does not justify rescaling
Exposure or capping the fitted Auto tone curve.

Run `src/scripts/test_tone_exposure.sh`. It rebuilds the existing `tone_sprint`
production renderer and develops just test_0002 and test_0017 at 1024px with Full
quality and Auto profile. A fresh temporary manifest uses the committed baseline
XMPs here, so the gate does not depend on the gitignored main reference manifest.
Only the six Auto baseline/Exposure outputs enter the gate; other outputs emitted
by the shared producer are unused. No original or adjacent sidecar is written.

No RAW fixtures: visible skip. Only one RAW, wrong RAW digest, missing/corrupt
reference, missing candidate, or wrong candidate dimensions: failure. The
mathematical gate self-test always runs before the fixture preflight and proves
that direction reversal, doubled response, and incomplete outputs fail. To
validate already-rendered files, run:

```sh
python3 tools/tone_exposure_gate.py --candidates /path/to/tone_sprint-output
python3 tools/tone_exposure_gate.py --self-test
```

## Measurement and budgets

Masks are fixed by the ACR baseline in twenty 5-L* bands, each requiring at least
200 pixels. Each renderer's own baseline is subtracted from its edited image
before comparing the signed spatial deltas. Band MAE is the equal-weight average
absolute error of those per-band means, in L*. It is not CIEDE2000 and does not
replace the canonical perceptual gate.

Initial measured band MAE / ceiling:

| Fixture | +1 EV | -1 EV |
|---|---:|---:|
| test_0002 | 1.255 / 1.36 | 1.294 / 1.40 |
| test_0017 | 4.502 / 4.87 | 4.339 / 4.69 |

Ceilings have about 8% headroom; ratchet them down with improvements, never raise
them to accommodate a regression. Both signs must move mean L* in the expected
direction. The magnitude of mean response must not exceed 1.10 times ACR's
response. That latter bound permits the target response itself and guards against
amplification; it does not freeze the current underresponse on test_0017.

The matched references show that test_0002 is already close to ACR. Test_0017
has modest excessive positive response in some bright regions but insufficient
whole-frame response. Across sixteen fixtures with an active Auto fit, controlled
AE-off comparisons found the Auto tail dampens mean exposure response overall.
A blanket slope cap would misdiagnose that redistribution and harm baseline
fidelity. This gate records a tested outcome for #3631 without changing Exposure.

## Provenance and reproduction

Photoshop 2026 **27.10.0**, Camera Raw **18.6 (2698)**, rendered 2026-09-14. The
repository's `src/scripts/acr-reference/acr_batch.jsx` ran against APFS clones of
the two RAWs, with isolated paths. Each baseline XMP was copied from that
fixture's existing baseline; the +/-1 variants change only `Exposure2012`.
ProcessVersion 11.0, As Shot WB, sharpening and other settings are preserved in
those XMPs. Test_0002 currently has Sharpness 40 / Radius 1.0; an old driver README
warning about a corrupted baseline does not apply to these settings.

ACR exported sRGB 8-bit PNGs at 4000px using BICUBICSHARPER, relative-colorimetric
profile conversion, black-point compensation, and dithering. These were resized
to 1024px with Pillow LANCZOS. `provenance.json` records application versions,
settings hashes, original RAW hashes, both PNG hashes, and dimensions. Clones
remained byte-identical to originals after rendering. New baseline renders matched
the existing ACR references at 1024px: mean DeltaE 0 for 0002 and 0.000000859 for 0017.

To regenerate, point a copied ACR driver at isolated RAW clones and the XMPs here,
render baseline/+1/-1 at 4000px with the recorded settings, then resize and verify
baseline comparability before replacing any committed image or provenance hash.
No competitor implementation source was used. Adobe's unit definition is in its
[Camera Raw tone documentation](https://helpx.adobe.com/camera-raw/desktop/using/make-color-tonal-adjustments-camera.html).
