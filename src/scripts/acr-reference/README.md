# ACR reference render pipeline

Tooling for producing ground-truth PNGs from ACR (Photoshop 2026 + Adobe
Camera Raw) for the Maple raw-pipeline test corpus. Companion to
[`test-fixtures/references/REFERENCES.md`](../../../test-fixtures/references/REFERENCES.md).

## Files

| File | Role |
| --- | --- |
| `matrix.py` | The 43-case matrix — slider overrides + tier mapping |
| `write_xmp.py` | Copy canonical XMPs from `test_0000/xmp/` into a target dir |
| `run.py` | Orchestrator — writes XMPs + `manifest.json` for every (RAW, case) |
| `acr_batch.jsx` | Photoshop ExtendScript — consumes `manifest.json`, renders PNGs |
| `render.sh` | Thin shell wrapper — drives Photoshop headlessly via `osascript` |

## One-shot render

From a shell on the Mac host:

```bash
cd /Users/riabuz/Projects/_Maple

# 1. (Re)generate XMPs + manifest.json for all 18 RAWs.
#    Already run once for you — only re-run if raws/ changes or cases update.
python3 src/scripts/acr-reference/run.py \
  --raws test-fixtures/raws/test_*.* \
  --out  test-fixtures/references/

# 2. Drive Photoshop headlessly.
./src/scripts/acr-reference/render.sh

```

Expected Photoshop runtime: ~4–5 minutes per RAW → **~75–90 minutes total** for
all 18 RAWs. Expected disk: **~38 GB** of PNGs (`down/` ≈ 2.7 GB + `full/` ≈ 35 GB).

## Design notes

### Authored inputs and explicit Adobe render settings

`run.py` keeps each `xmp/` copy byte-identical to the canonical case under
`test_0000/xmp/`. The manifest's `xmp` remains Maple's input. A separate
`acr-xmp/` sidecar, referenced by `acr_xmp`, pins omitted Adobe controls to
neutral values while preserving explicit case overrides and unknown XML.
This includes tone, point curves, white balance, lens/CA, geometry and detail
settings. Missing white balance is As Shot; derived temperature/tint is not
an override. Explicit custom curves retain their points and name.

CameraProfile is preserved when authored. Otherwise the generator reuses the
fixture's recorded `acr-xmp/baseline.xmp`, or bootstraps from effective XMP in an
existing baseline PNG. This preserves camera-specific choices such as Camera
Standard and Adobe Standard v2. New fixtures without recorded settings must
author a profile; there is no blanket profile fallback. ProcessVersion defaults
to 11.0. Both effective controls are checked in saved PNGs.

This separation matters: Adobe's `LensProfileEnable=0` disables its optional
lens profile, while Maple currently interprets that sidecar field as disabling
embedded DNG opcodes too. Do not propagate Adobe-only defaults into Maple inputs.

For #3633, effective PNG metadata revealed inherited lens/CA settings in five
fixtures and Whites/Blacks/Clarity in test_0015, despite their omission from the
paired XMP. `render.sh` now verifies every saved PNG against the explicit Adobe
sidecar and fails on missing metadata or mismatched effective settings. Old
manifests must be regenerated before rendering. Reference replacements still
require geometry and perceptual checks; existing budgets cannot increase.

Run the focused XML, manifest and PNG metadata tests with:

```bash
python3 -m unittest discover -s src/scripts/acr-reference -p 'test_*.py'
```

### Sandbox → Mac path translation

`run.py` auto-translates the Cowork-sandbox mount
(`/sessions/<id>/mnt/_Maple/...`) to the host path (`/Users/riabuz/Projects/_Maple/...`)
before writing `manifest.json`, because Photoshop runs on the host Mac and
needs literal host paths. Override the host root with `--mac-root` if your
layout differs.

### ExtendScript gotchas already handled in `acr_batch.jsx`

- No native `JSON` — uses `eval()` wrapped with `(...)` to parse the
  manifest. Safe because we generate the manifest ourselves.
- No `Date.toISOString` — uses manual `pad2()` for log timestamps.
- `DialogModes.NO` silences ACR prompts; `displayDialogs = NO` on the
  application silences everything else.
- `doc.close(SaveOptions.DONOTSAVECHANGES)` guarantees the RAW is never
  modified.
- Each case restores any prior raw-adjacent sidecar byte-for-byte, including
  after a render failure. If none existed, the temporary sidecar is removed.
  Only the document opened for that case is closed; unrelated documents and
  application preferences are preserved. `--cleanup-only` is a legacy recovery
  tool, not a step in a new render.

## Rename map — original filenames → test_NNNN

The corpus was flattened into sequential `test_NNNN` names. Alphabetical
by original filename for stability:

| test_NNNN | Original filename | Camera / notes |
| --- | --- | --- |
| `test_0000.DNG`  | *(already named)* | 100 MP Hasselblad L3D-100c reference |
| `test_0001.RAW`  | *(already named)* | — |
| `test_0002.dng`  | *(already named)* | — |
| `test_0003.CR2`  | *(already named)* | — |
| `test_0004.fff`  | `20151114_CCSG_on_Hasselblad_H5D40-0726.fff` | Hasselblad H5D-40 (medium format + colorchecker_d65) |
| `test_0005.RAF`  | `20170525_0037TEST.RAF` | **Uncataloged** — not in fixtures.toml |
| `test_0006.DNG`  | `5G4A9394-compressed-lossy.DNG` | Canon 5D III (via DNG Converter) — lossy JPEG DNG |
| `test_0007.DNG`  | `5G4A9394-uncompressed.DNG` | Canon 5D III (via DNG Converter) — uncompressed linear DNG |
| `test_0008.RAF`  | `AFXT2721.RAF` | Fuji X-T3 — X-Trans III |
| `test_0009.CR2`  | `B13A0729.CR2` | Canon 5D IV — clipped highlights scene |
| `test_0010.CR2`  | `B13A0733.CR2` | Canon 5D IV — primary Bayer fixture |
| `test_0011.ARW`  | `DSC00396.ARW` | Sony α7R IV — 61 MP |
| `test_0012.raf`  | `DSCF1317_GFX50R.raf` | Fuji GFX 50R — 51 MP medium format |
| `test_0013.DNG`  | `IMG_1361.DNG` | iPhone 12 Pro — OpcodeList3, dual illuminant |
| `test_0014.NEF`  | `Nikon-D850-14bit-lossless-compressed.NEF` | Nikon D850 |
| `test_0015.dng`  | `PXL_20220910_093206982.dng` | Pixel 6 Pro — 10-bit DNG |
| `test_0016.X3F`  | `SDIM0042.X3F` | Sigma SD1 Merrill — Foveon X3 |
| `test_0017.dng`  | `f5381888.dng` | Leica M10 — dual-illuminant WB |

Pano fixtures `pano_00/` and `pano_01/` were intentionally **not** renamed —
they're multi-file stitching fixtures, not single-image test subjects.

## Caveats / known issues (surfaced during this regeneration)

1. **`test_0002/xmp/baseline.xmp` is corrupted.** It reports
   `Sharpness="0"` and `SharpenRadius="0.5"` where the canonical
   baseline has `Sharpness="40"` and `SharpenRadius="1.0"`. Looks like
   a `sharpen_amount_min` / `sharpen_radius_min` leak from an earlier
   buggy run. Fix by re-running `run.py` with `--cases-filter baseline`
   and then re-rendering that one case in Photoshop. **The test_0002 PNGs
   currently referenced as "ground truth" may be subtly wrong.**

2. **`test_0005.RAF` (originally `20170525_0037TEST.RAF`) is not in
   `fixtures.toml`.** It was uncataloged before the rename too. When you
   know the camera/dimensions, add a `[[fixture]]` entry with category.

3. **`fixtures.toml` uses categorized subpaths** (e.g.
   `01_decode/bayer/canon/test_0010.CR2`) but the filesystem is flat
   (all RAWs live directly in `test-fixtures/raws/`). This inconsistency
   predates this rename — the rename preserved the existing subpath
   scheme. If you want the corpus reorganized into subdirs, that's a
   separate move. The verification harness here checks by *basename*,
   so the current layout works.

4. **`fixtures.toml`'s `[[fixture]]` for `colorchecker_d65`** references
   `test_0004.fff` — the same file as the medium_format entry.
   Originally documented as a symlink but the filesystem has no symlink;
   both entries point at the single flat file. Pre-existing; not touched.
