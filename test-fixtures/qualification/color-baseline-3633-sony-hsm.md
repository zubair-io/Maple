## Isolated Sony HSM attribution — rejected as a fix

Diagnostic source `raw-core/examples/sony-hsm-probe.rs` (97 lines) at parent
source revision d9e570ace decodes the original Sony ARW, renders the unchanged
Neutral/AMaZE control with bundled lens matching disabled, then injects ONLY
the two exact HSM arrays from the installed Adobe Standard DCP into RawImage's
documented bundle fallback. It asserts identical resolved source
(BundleConfident), CM/FM, scene white/CCT, baked-WB flag, AsShotNeutral and
BaselineExposure; PLT/PTC remain absent. The model/XMP and source RAW stay fixed.
The original decoded black levels are 512; white 15360. No bundle is regenerated.

DCP SHA256: a35223d09219f5b90d077babe897b6a05eb611bf7d4deb28f7b763b127e1b121.
Its exact HSM 90×30×1 arrays and encoding were extracted read-only with tifffile
into `/tmp/maple-3633-sony-hsm.json`; no new dependency or production profile
flag was added. Both native outputs are 9504×6336 and marked read-only.

| Variant        |    Mean |      p95 |      Max | RGB bias                    |
| -------------- | ------: | -------: | -------: | --------------------------- |
| Control        | 5.63790 | 19.56266 | 34.81105 | +.03783 / +.03154 / +.03118 |
| Exact Sony HSM | 7.67287 | 19.55797 | 46.10497 | +.01672 / +.01850 / +.03889 |

Metrics use the current canonical `diff_manifest_case` baseline protocol:
validate the Adobe XMP/settings/native dimensions, then reduce both native
candidate and reference with Lanczos to 4000×2667. This is separate from the
older direct-down reference metrics. Both variants still fail the .0113 bias
ceiling; adding HSM worsens mean/max and blue bias.

A reference-derived dark neutral mask (encoded-sRGB max channel(.03,.5), HSV
saturation<.1) covers 4.864% of pixels. Descriptive float64 RGB residuals change
from +.13403/.13448/.13363 to +.13633/.13795/.13674: HSM does not remove the broad
neutral brightness mismatch. This falsifies missing HSM as a sufficient fix
for the observed Sony failure; it does not establish that HSM should never be
used for camera colorimetry.

Artifacts: `/tmp/maple-3633-sony-hsm-output/{control,hsm}.png`, `metrics.json`;
`/tmp/maple-3633-sony-hsm-{build,run,metrics}.log`; reproducible comparison script
`/tmp/maple-3633-sony-hsm-compare.py`. Build used release jobs 4, rendering Rayon 4;
other baseline renders were active, so no performance claim is made.

### Reproduce

Run from the repository root. `RAW` and `XMP` are read-only installed paths
for test_0011.ARW and its canonical baseline.xmp. The DCP is local proprietary
input; no extracted table bytes are committed. This example does not verify
that an arbitrary JSON file came from the named DCP; the exact extraction and
hash below provide that provenance for this run.

```bash
python3 - <<'PY'
import hashlib, json, pathlib, tifffile
p = pathlib.Path('/Library/Application Support/Adobe/CameraRaw/CameraProfiles/Adobe Standard/Sony ILCE-7RM4 Adobe Standard.dcp')
with tifffile.TiffFile(p) as f:
    t = f.pages[0].tags
    data = {
        'source_sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
        'dims': list(t[50937].value),
        'encoding': int(t[51107].value) if 51107 in t else 0,
        'data1': t[50938].value.tolist(),
        'data2': t[50939].value.tolist(),
    }
pathlib.Path('/tmp/maple-3633-sony-hsm.json').write_text(json.dumps(data))
PY
cargo build --release --manifest-path src/raw-pipeline/Cargo.toml \
  -p raw-core --example sony-hsm-probe -j4
RAYON_NUM_THREADS=4 src/raw-pipeline/target/release/examples/sony-hsm-probe \
  "$RAW" "$XMP" /tmp/maple-3633-sony-hsm.json /tmp/sony-hsm-new-run
```

The output directory must not exist. Compare each PNG with
`compare_images.diff_manifest_case(candidate, outputs, 'down',
case_label='baseline', reference_xmp=adobe_sidecar)` using the unchanged
manifest's full/down references. The earlier comparison script records the
mask formula; all resulting scalar metrics and PNG hashes are preserved in
`color-baseline-3633-sony-hsm.json`. The control PNG is byte-identical to the canonical CLI output at
`/var/folders/qn/gpgsv1591kz40pfbjgnnvzxm0000gn/T/maple-calibrate-XXXXXX.RERPlLRXpG/candidates/test_0011_baseline.png`:
both SHA256 `4b58a8340728f0e16101c88130bce4b54ac0473ff2ed25115f1a87becabf3173`.
