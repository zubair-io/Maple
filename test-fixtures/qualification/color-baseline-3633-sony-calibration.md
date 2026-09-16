## Sony calibration follow-up — read-only evidence

No concrete wrong exposure or camera-matrix setting was found. The existing
inspect-camera run reports BaselineExposure=0 and AsShotNeutral
[0.32569975,1,0.6666667]. ExifTool reads the original's WB_RGGBLevels as
3144/1024/1024/1536, whose green-normalized inverse agrees. Original black
levels are512 in all four positions, white levels15360, ISO50. Decoder code
reads these Sony SR2 tags; no unsupported black-level correction is justified
without inspecting actual decoded statistics. The installed Sony ILCE-7RM4
Adobe Standard DCP's CM1/CM2/FM1/FM2 agree with the existing bundled-profile
inspection. Its BaselineExposureOffset and ProfileToneCurve tags are absent.

A real calibration omission exists, but is documented rather than a newly
stale bundle: the committed native profiles.bin is v1, and its Sony record has
flags0x0f (four matrices only), zero HSM dimensions, and BEoffset0. The actual
Adobe Standard DCP has two90×30×1 HueSatMaps. `profile_loader/mod.rs` forwards
HSM when present; vendor ARW has no source DNG HSM fallback. The explicit
comment/test in `color/dcp.rs` around line2450 documents the matrix-only
committed bundle and the external `convert_dcps.py --include-hsm` corpus
requirement. The converter deliberately defaults HSM off; HSM is compatible
colorimetry, unlike the intentionally excluded Adobe aesthetic PLT/PTC.

This is NOT evidence that enabling HSM fixes the bias. Both installed HSMs
leave the saturation-zero value scale at1, and every value scale is >=1:
A range1–1.5129871, D65 range1–1.6714287. The installed PLT has value scale1
throughout and neutral entries identity; this body has no explicit PTC to
restore. Hue/saturation changes can still affect output channels and AgX, so
only an objective isolated experiment can measure their net effect.

The existing corrected-reference bias also survives a low-saturation mask:
select reference encoded-sRGB max channel in(.03,.5), then HSV saturation
(max−min)/max. Same existing unchanged-main native candidate, Lanczos resized,
float64 mean accumulation for descriptive statistics:

| Reference saturation | Image fraction | RGB mean residual           |
| -------------------- | -------------: | --------------------------- |
| 0–.1                 |          4.74% | +.13378 / +.13417 / +.13328 |
| .1–.3                |         24.49% | +.11563 / +.11381 / +.11493 |
| .3–1                 |         18.60% | +.07109 / +.06901 / +.07387 |

Thus a sizeable near-achromatic dark region is too bright. Missing chromatic
HSM correction alone is a weak explanation for that almost equal-channel
residual; no source change or tuning is supported by these data.

Falsifiable next diagnostics, outside this read-only task:

1. Inspect decoded Sony black/white levels and normalized sensor samples at
   several flat, low-saturation dark-region pixels, before WB and AgX; compare
   ARW decode with a losslessly converted DNG control carrying the SAME camera
   calibration and no lens/tonal edits. Pin dimensions/crop and calibration
   provenance. If sensor-normalized values agree, stop pursuing decoder black
   offsets; if not, localize the mismatch before the view transform. This
   avoids inferring sensor error solely from a display-referred ACR PNG.
2. In an isolated diagnostic only, inject this body's exact existing DCP HSM
   into its resolved profile while keeping matrices, BE, PLT/PTC exclusion,
   AgX, RAW and XMP fixed. No existing CLI external-DCP flag was found. Measure
   both the canonical gate and the neutral mask above. Its identity neutral
   rows predict little movement for truly achromatic pixels; reject it as a
   global-tone fix if that prediction holds. Do not regenerate the entire
   camera bundle merely to run a single-body attribution experiment.

No missing credential or calibration file blocks those diagnostics: the actual
DCP is installed at /Library/Application Support/Adobe/CameraRaw/CameraProfiles/
Adobe Standard/Sony ILCE-7RM4 Adobe Standard.dcp. An ACR display reference alone
cannot establish which renderer has the correct scene-linear brightness.
Neutral deliberately uses AgX and Auto remains the default; treating Neutral
as Adobe-tone-equivalent would require a product/qualification decision,
not an undocumented curve adjustment to fit this one photograph.
