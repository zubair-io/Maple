# Bundled Lensfun lens corrections — slices 1 and 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** raw-core ships the Lensfun database and applies a matched lens calibration automatically in the develop path, verified against `liblensfun` and against the Adobe LCP for the same lens.

**Architecture:** A converter script turns the pinned Lensfun XML into a compact binary table of calibrations already expressed in raw-core's focal-normalised frame (`lens_profile/lensfun/db.bin`, `include_bytes!`). A reader builds an index of mounts, cameras and lenses; a matcher turns EXIF identity into a lens; the existing resolver interpolates the lens's samples exactly as it does for LCP samples; `apply_for_raw` runs the match when the sidecar names no profile. `Perspective` gains odd-power radial terms for Lensfun's `ptlens` and TCA models.

**Tech Stack:** Rust (raw-core, `quick-xml` is NOT used at runtime — the table is binary), Python 3 for the converter (`xml.etree`), C++ for the one-off `liblensfun` reference harness, `maple-cli` for the gates.

**Spec:** `docs/superpowers/specs/2026-09-12-lensfun-bundled-lens-corrections-design.md`

## Global Constraints

- Every file stays under 570 lines (`tools/check-budget-headroom.sh`); the hard ceiling is 600. Split before you reach it.
- Adobe LCP behaviour must stay byte-identical: every existing `lens_profile` test passes unchanged, and `radial_odd == [0, 0]` must take the existing code path.
- An automatic match writes nothing to the sidecar. Only a manual pick writes `papp:LensProfile="lensfun1:<slug>"`.
- Embedded `OpcodeList3` wins over everything; an explicit `lcp1:` / `lcp1-ack:` selection wins over a Lensfun match; `crs:LensProfileEnable="0"` disables both.
- Exact normalised matching only. No fuzzy scoring, no "closest lens".
- The bundled data is CC BY-SA 3.0: `ATTRIBUTION.md` ships next to `db.bin` with the licence text, the source commit and the conversion rules. Nothing from Adobe enters the build.
- Commit with `LEFTHOOK=0`, stage explicit paths, conventional messages, no `Co-Authored-By` trailer. `rustfmt --check` is clean on every touched Rust file (`cargo fmt -p raw-ffi` is a CI gate; raw-core files are formatted per hunk).
- Colour evidence: after Task 8 the full `src/scripts/test_color_pipeline.sh` runs over all fixtures in `/Users/riabuz/Projects/_Maple/test-fixtures/raws` (symlink them into the worktree); budgets only ratchet down.

---

## Canonical lens and camera names

Used by the converter (Task 3) and the matcher (Task 5). Both sides must agree byte-for-byte, so the rule lives in one place per language and is tested with the same table.

```
canonical(maker, name):
  s = lowercase(name)
  m = lowercase(maker)
  if s starts with m + " " : s = s[len(m)+1:]        # "Canon EF 50mm…" → "ef 50mm…"
  s = s.replace("f/", "f")                             # "f/4" ≡ "F4"
  s = remove every whitespace character                # "FE 24-70mm F4 ZA OSS" → "fe24-70mmf4zaoss"
  return s
```

Table the tests use (EXIF value → Lensfun `model`, all must be equal after `canonical`):

| maker    | EXIF                          | Lensfun                              |
| -------- | ----------------------------- | ------------------------------------ |
| Sony     | `FE 24-70mm F4 ZA OSS`        | `FE 24-70mm f/4 ZA OSS`              |
| Canon    | `EF70-200mm f/2.8L IS II USM` | `Canon EF 70-200mm f/2.8L IS II USM` |
| Canon    | `EF50mm f/1.2L USM`           | `Canon EF 50mm f/1.2L USM`           |
| Fujifilm | `XF35mmF2 R WR`               | `XF 35mm f/2 R WR`                   |

Camera models use the same function with the maker as prefix (`Canon EOS 5D Mark III` → `eos5dmarkiii`, `NIKON D850` with maker `NIKON CORPORATION` → maker canonical is `nikoncorporation`, which is not a prefix, so the model stays `nikond850`; the Lensfun maker is `Nikon` and model `Nikon D850` → `d850`). To make both sides meet, camera canonicalisation strips ANY leading token that equals the first token of the maker (`nikon`), so both become `d850`. Test this case explicitly.

---

### Task 1: `liblensfun` reference vectors

**Files:**

- Create: `src/scripts/lensfun_reference.cpp`
- Create: `src/scripts/lensfun_reference.sh`
- Create: `test-fixtures/qualification/lensfun-reference.json`

**Interfaces:**

- Produces: the JSON consumed by Task 4's tests. Shape:

```json
{
  "db_commit": "12f5976",
  "cases": [
    {
      "camera": {"maker": "Sony", "model": "ILCE-7RM4"},
      "lens": {"maker": "Sony", "model": "FE 24-70mm f/4 ZA OSS"},
      "crop": 1.0, "width": 9504, "height": 6336,
      "focal": 24.0, "aperture": 5.6, "distance": 5.0,
      "points": [[4752.0, 3168.0], [2376.0, 1584.0], [0.0, 0.0], [9503.0, 6335.0], [9503.0, 3168.0]],
      "distortion": [[x_src, y_src], ...],
      "tca": [[[xr, yr], [xg, yg], [xb, yb]], ...],
      "vignetting": [factor, ...]
    }
  ]
}
```

Cases: Sony ILCE-7RM4 + `FE 24-70mm f/4 ZA OSS` at focal 24, 35, 70 (aperture 5.6, distance 5.0, 9504×6336); Canon EOS 5D Mark III + `Canon EF 70-200mm f/2.8L IS II USM` at 70 and 200 (aperture 4, distance 10, 5760×3840); Fujifilm X-T3 + `XF 35mm f/2 R WR` at 35 (aperture 2.8, distance 3, 6240×4160, crop 1.5). Use exact focal lengths that exist as `<distortion focal=…>` samples so no spline interpolation is involved; check with `grep focal=`.

- [ ] **Step 1: Write the harness**

```cpp
// src/scripts/lensfun_reference.cpp — prints liblensfun's answers for the
// cases Maple's Lensfun port is tested against (#3565). Build with
// src/scripts/lensfun_reference.sh <lensfun-checkout>.
#include <lensfun/lensfun.h>
#include <cstdio>
#include <cstring>
#include <vector>

struct Case { const char *cmaker, *cmodel, *lmaker, *lmodel; float crop; int w, h; float focal, aperture, distance; };

static void run(lfDatabase &db, const Case &c, bool &first) {
    const lfCamera **cams = db.FindCamerasExt(c.cmaker, c.cmodel);
    if (!cams) { fprintf(stderr, "no camera %s %s\n", c.cmaker, c.cmodel); return; }
    const lfLens **lenses = db.FindLenses(cams[0], c.lmaker, c.lmodel);
    if (!lenses) { fprintf(stderr, "no lens %s\n", c.lmodel); return; }
    const lfLens *lens = lenses[0];
    const float pts[5][2] = {{c.w/2.0f, c.h/2.0f}, {c.w/4.0f, c.h/4.0f}, {0, 0}, {c.w-1.0f, c.h-1.0f}, {c.w-1.0f, c.h/2.0f}};
    lfModifier mod(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    printf("%s{\"camera\":{\"maker\":\"%s\",\"model\":\"%s\"},\"lens\":{\"maker\":\"%s\",\"model\":\"%s\"},"
           "\"crop\":%g,\"width\":%d,\"height\":%d,\"focal\":%g,\"aperture\":%g,\"distance\":%g,\"points\":[",
           first ? "" : ",", c.cmaker, c.cmodel, lens->GetMaker(), lens->GetModel(), c.crop, c.w, c.h, c.focal, c.aperture, c.distance);
    first = false;
    for (int i = 0; i < 5; i++) printf("%s[%g,%g]", i ? "," : "", pts[i][0], pts[i][1]);
    printf("],\"distortion\":[");
    mod.EnableDistortionCorrection();
    for (int i = 0; i < 5; i++) { float r[2]; mod.ApplyGeometryDistortion(pts[i][0], pts[i][1], 1, 1, r); printf("%s[%.6f,%.6f]", i ? "," : "", r[0], r[1]); }
    printf("],\"tca\":[");
    lfModifier tca(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    tca.EnableTCACorrection();
    for (int i = 0; i < 5; i++) { float r[6]; tca.ApplySubpixelDistortion(pts[i][0], pts[i][1], 1, 1, r); printf("%s[[%.6f,%.6f],[%.6f,%.6f],[%.6f,%.6f]]", i ? "," : "", r[0], r[1], r[2], r[3], r[4], r[5]); }
    printf("],\"vignetting\":[");
    lfModifier vig(lens, c.focal, c.crop, c.w, c.h, LF_PF_F32, false);
    vig.EnableVignettingCorrection(c.aperture, c.distance);
    for (int i = 0; i < 5; i++) { float px[3] = {1, 1, 1}; vig.ApplyColorModification(px, pts[i][0], pts[i][1], 1, 1, LF_CR_3(LF_CR_RED, LF_CR_GREEN, LF_CR_BLUE), 3 * sizeof(float)); printf("%s%.6f", i ? "," : "", px[1]); }
    printf("]}\n");
    lf_free(lenses); lf_free(cams);
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s <db-dir> <db-commit>\n", argv[0]); return 2; }
    lfDatabase db;
    if (db.Load(argv[1]) != LF_NO_ERROR) { fprintf(stderr, "db load failed\n"); return 1; }
    const Case cases[] = {
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 24, 5.6f, 5},
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 35, 5.6f, 5},
        {"Sony", "ILCE-7RM4", "Sony", "FE 24-70mm f/4 ZA OSS", 1.0f, 9504, 6336, 70, 5.6f, 5},
        {"Canon", "Canon EOS 5D Mark III", "Canon", "Canon EF 70-200mm f/2.8L IS II USM", 1.0f, 5760, 3840, 70, 4, 10},
        {"Canon", "Canon EOS 5D Mark III", "Canon", "Canon EF 70-200mm f/2.8L IS II USM", 1.0f, 5760, 3840, 200, 4, 10},
        {"Fujifilm", "X-T3", "Fujifilm", "XF 35mm f/2 R WR", 1.5f, 6240, 4160, 35, 2.8f, 3},
    };
    printf("{\"db_commit\":\"%s\",\"cases\":[", argv[2]);
    bool first = true;
    for (const Case &c : cases) run(db, c, first);
    printf("]}\n");
    return 0;
}
```

The vignetting call: `ApplyColorModification(pixels, x, y, width, height, comp_role, row_stride)`; `px[1]` is the green multiplier — it is the same for all channels in the `pa` model. If a case's focal length is not an exact `<distortion focal>` sample in the database, change it to one that is (`grep 'focal="' data/db/mil-sony.xml`), and record why in the JSON's `notes` if you add one.

- [ ] **Step 2: Write the build script**

```bash
#!/usr/bin/env bash
# src/scripts/lensfun_reference.sh <lensfun-checkout> — builds liblensfun
# (static, no python, no tools) and regenerates
# test-fixtures/qualification/lensfun-reference.json.
set -euo pipefail
LF="${1:?lensfun checkout}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$LF/build" && cd "$LF/build"
cmake .. -DBUILD_STATIC=ON -DBUILD_TESTS=OFF -DBUILD_LENSTOOL=OFF -DINSTALL_HELPER_SCRIPTS=OFF -DBUILD_DOC=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build . --target lensfun -j8 >/dev/null
c++ -std=c++17 -O2 -I "$LF/build/include" -I "$LF/include" "$ROOT/src/scripts/lensfun_reference.cpp" \
  "$LF/build/libs/lensfun/liblensfun.a" $(pkg-config --cflags --libs glib-2.0) -o "$LF/build/lensfun_reference"
"$LF/build/lensfun_reference" "$LF/data/db" "$(git -C "$LF" rev-parse --short HEAD)" \
  | python3 -m json.tool > "$ROOT/test-fixtures/qualification/lensfun-reference.json"
echo "wrote test-fixtures/qualification/lensfun-reference.json"
```

- [ ] **Step 3: Run it against the snapshot clone**

Run: `bash src/scripts/lensfun_reference.sh /private/tmp/claude-501/…/scratchpad/lensfun` (the clone at commit `12f5976`; `cmake --build --target lensfun` avoids the python package that fails on this Mac).
Expected: a JSON with 6 cases, every `distortion` centre point equal to the input centre within 1e-3, corner sources inside `[0, w] × [0, h]` for all but strongly barrel-distorted cases, vignetting centre factor `1.000000` and corner factors `> 1`.

- [ ] **Step 4: Commit**

```bash
LEFTHOOK=0 git add src/scripts/lensfun_reference.cpp src/scripts/lensfun_reference.sh test-fixtures/qualification/lensfun-reference.json
LEFTHOOK=0 git commit -m "test(lens): liblensfun reference vectors for the Lensfun port"
```

---

### Task 2: Odd-power radial terms on `Perspective`

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/lens_profile/model.rs` (`Perspective`, `normalized`, `perspective()`)
- Modify: `src/raw-pipeline/raw-core/src/lens_profile/resolve.rs` (`blend_perspective` — blends `radial_odd` like `radial`)
- Test: `src/raw-pipeline/raw-core/src/lens_profile/tests.rs`

**Interfaces:**

- Produces: `Perspective { frame, radial: [f64; 3], radial_odd: [f64; 2], tangential, scale }` where `radial_odd = [c1, c3]` multiply `r` and `r³`. Evaluation: `radial = 1 + c1·r + k1·r² + c3·r³ + k2·r⁴ + k3·r⁶`. Every existing constructor sets `radial_odd: [0.0, 0.0]`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn odd_radial_terms_evaluate_the_ptlens_polynomial() {
    let p = Perspective {
        frame: Frame { focal: [1.0, 1.0], center: [0.5, 0.5] },
        radial: [0.02, 0.0, 0.0],
        radial_odd: [0.01, -0.03],
        tangential: [0.0; 2],
        scale: 1.0,
    };
    // width = height = 200 → maximum 200, focal 200 px: point (150,100) is x = 0.25, r = 0.25
    let [x, y] = p.map(200.0, 200.0, [150.0, 100.0]);
    let r = 0.25f64;
    let poly = 1.0 + 0.01 * r + 0.02 * r * r - 0.03 * r * r * r;
    assert!((x - (100.0 + 50.0 * poly)).abs() < 1e-9, "{x}");
    assert!((y - 100.0).abs() < 1e-9);
}

#[test]
fn zero_odd_terms_are_the_adobe_polynomial() {
    let even = Perspective { frame: Frame { focal: [1.0, 1.0], center: [0.5, 0.5] }, radial: [0.1, -0.05, 0.01], radial_odd: [0.0; 2], tangential: [0.001, -0.002], scale: 1.02 };
    let point = [173.0, 41.0];
    let [x, y] = even.map(300.0, 200.0, point);
    let [nx, ny] = even.frame.coordinates(300.0, 200.0, point);
    let r2 = nx * nx + ny * ny;
    let radial = 1.0 + r2 * (0.1 + r2 * (-0.05 + r2 * 0.01));
    let expected = even.frame.pixels(300.0, 200.0, [
        1.02 * (nx * radial + 2.0 * 0.001 * nx * ny + -0.002 * (r2 + 2.0 * nx * nx)),
        1.02 * (ny * radial + 0.001 * (r2 + 2.0 * ny * ny) + 2.0 * -0.002 * nx * ny),
    ]);
    assert!((x - expected[0]).abs() < 1e-12 && (y - expected[1]).abs() < 1e-12);
}
```

- [ ] **Step 2: Run to see the compile failure** — `cargo test -p raw-core --lib lens_profile::tests::odd_radial` → error: no field `radial_odd`.

- [ ] **Step 3: Implement**

In `model.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Perspective {
    pub frame: Frame,
    pub radial: [f64; 3],
    /// Coefficients of `r` and `r³` (Lensfun `ptlens` and TCA `poly3`).
    /// Adobe profiles never set them; both zero keeps the even-only path.
    pub radial_odd: [f64; 2],
    pub tangential: [f64; 2],
    pub scale: f64,
}

fn normalized(self, [x, y]: [f64; 2]) -> [f64; 2] {
    let r2 = x * x + y * y;
    let [k1, k2, k3] = self.radial;
    let [p1, p2] = self.tangential;
    let even = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3));
    let radial = match self.radial_odd {
        [0.0, 0.0] => even,
        [c1, c3] => {
            let r = r2.sqrt();
            even + r * (c1 + r2 * c3)
        }
    };
    [
        self.scale * (x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)),
        self.scale * (y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y),
    ]
}
```

Add `radial_odd: [0.0; 2]` in `perspective()` and everywhere a `Perspective` literal is built (`grep -rn "Perspective {" src/raw-pipeline/raw-core/src`). In `resolve.rs` `blend_perspective`, blend `radial_odd` component-wise with the same weights as `radial`.

- [ ] **Step 4: Run** — `cargo test -p raw-core --lib lens_profile` → all pass, including the pre-existing suite.

- [ ] **Step 5: Commit** — `git add src/raw-pipeline/raw-core/src/lens_profile/model.rs src/raw-pipeline/raw-core/src/lens_profile/resolve.rs src/raw-pipeline/raw-core/src/lens_profile/tests.rs && git commit -m "feat(lens): odd-power radial terms on Perspective for Lensfun's ptlens and TCA models"`

---

### Task 3: Converter script and bundle

**Files:**

- Create: `src/scripts/convert_lensfun_db.py`
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/db.bin` (generated)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/ATTRIBUTION.md` (generated header + licence text copied from `docs/cc-by-sa-3.0.txt` of the checkout)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/COVERAGE.md` (generated)
- Test: `src/scripts/test_convert_lensfun_db.py` (pure-Python unit tests of the conversion maths and canonicalisation; run with `python3 -m pytest src/scripts/test_convert_lensfun_db.py` or plain `python3 src/scripts/test_convert_lensfun_db.py`)

**Interfaces:**

- Produces: `db.bin` in the format below, read by Task 4. Little-endian throughout.

```
header:   magic b"MLFN" | u16 version = 1 | u16 reserved | u32 n_strings | u32 n_mounts | u32 n_cameras | u32 n_lenses | u8[12] db_commit (ascii, NUL-padded) | u8[10] db_date "YYYY-MM-DD"
strings:  n_strings × (u16 len | utf8 bytes)          — every name below is an index (u32) into this table
mount:    u32 name | u16 n_compat | n_compat × u32 name
camera:   u32 maker | u32 model | u16 n_variants | n_variants × u32 name | u32 mount (index into mounts) | f32 crop
          — `model` is the raw `<model>` (no lang); variants are every `<model lang=…>` and `<variant>` text
lens:     u32 maker | u32 model | u16 n_names | n_names × u32 (lang variants) | u16 n_mounts | n_mounts × u32 mount index
          | f32 crop | f32 aspect | u8 kind (0 rectilinear, 1 other — skipped from matching, kept for COVERAGE)
          | u16 n_dist | n_dist × dist | u16 n_tca | n_tca × tca | u16 n_vig | n_vig × vig
dist:     f32 focal | f32 real_focal | f32 scale | f32[3] even | f32[2] odd        (converted, see spec)
tca:      f32 focal | f32 real_focal | 2 × (f32 scale | f32[3] even | f32[2] odd)  (red then blue, relative to green)
vig:      f32 focal | f32 aperture | f32 distance | f32[3] k
```

`real_focal` is the sample's `real-focal` attribute when present, else `focal`. `<distortion>` entries also carry an optional `real-focal`; when only some samples carry it, the missing ones use `focal`, matching `liblensfun`'s `RealFocal = Focal` fallback.

Conversion (Python, exactly the spec's formulas; `crop`, `aspect` are the lens's own values, `aspect` parsed from `"3:2"` → 1.5, default 1.5):

```python
DIAG = math.hypot(36.0, 24.0)

def hugin_scale_mm(crop, aspect):      # distortion / TCA: r = 1 at half the short side
    return DIAG / crop / math.hypot(aspect, 1.0) / 2.0

def vignette_scale_mm(crop):           # vignetting: r = 1 at the corner
    return DIAG / crop / 2.0

def convert_distortion(model, terms, real_focal, crop, aspect):
    s = real_focal / hugin_scale_mm(crop, aspect)
    if model == "poly3":
        k1 = terms["k1"]; d = 1.0 - k1
        return dict(scale=d, even=[k1 * s**2 / d**3, 0.0, 0.0], odd=[0.0, 0.0])
    if model == "poly5":
        return dict(scale=1.0, even=[terms["k1"] * s**2, terms["k2"] * s**4, 0.0], odd=[0.0, 0.0])
    if model == "ptlens":
        a, b, c = terms["a"], terms["b"], terms["c"]; d = 1.0 - a - b - c
        return dict(scale=d, even=[b * s**2 / d**3, 0.0, 0.0], odd=[c * s / d**2, a * s**3 / d**4])
    raise ValueError(model)

def convert_tca(model, terms, real_focal, crop, aspect):
    s = real_focal / hugin_scale_mm(crop, aspect)
    if model == "linear":
        return [dict(scale=terms["kr"], even=[0, 0, 0], odd=[0, 0]), dict(scale=terms["kb"], even=[0, 0, 0], odd=[0, 0])]
    if model == "poly3":
        return [dict(scale=terms["vr"], even=[terms["br"] * s**2, 0, 0], odd=[terms["cr"] * s, 0.0]),
                dict(scale=terms["vb"], even=[terms["bb"] * s**2, 0, 0], odd=[terms["cb"] * s, 0.0])]
    raise ValueError(model)

def convert_vignetting(model, terms, real_focal, crop):
    s = real_focal / vignette_scale_mm(crop)
    if model != "pa": raise ValueError(model)
    return [terms["k1"] * s**2, terms["k2"] * s**4, terms["k3"] * s**6]
```

Why `d` is a `scale`, not dropped: `liblensfun` absorbs the `1 − k1` (or `1 − a − b − c`) factor into its coordinate frame and treats it as an image zoom. raw-core's `Perspective.scale` carries exactly that factor, so the converted model reproduces `liblensfun`'s `Rd` including the zoom; the evaluator of Task 2 applies `scale` after the polynomial, which is the same as `liblensfun`'s `Ru' = d·Ru` substitution.

Attributes missing from a sample (`k2` absent in a `poly5`, `k3` absent in `pa`) default to 0. A `<distortion>` with an unknown `model`, a lens with `type` other than `rectilinear`/absent, or a sample with a non-positive `focal` is skipped and listed in `COVERAGE.md` under "Skipped".

- [ ] **Step 1: Unit tests for the conversion** (`src/scripts/test_convert_lensfun_db.py`)

```python
import math, unittest
from convert_lensfun_db import canonical, convert_distortion, convert_tca, convert_vignetting, hugin_scale_mm

class Canonical(unittest.TestCase):
    def test_pairs(self):
        for maker, exif, lf in [
            ("Sony", "FE 24-70mm F4 ZA OSS", "FE 24-70mm f/4 ZA OSS"),
            ("Canon", "EF70-200mm f/2.8L IS II USM", "Canon EF 70-200mm f/2.8L IS II USM"),
            ("Canon", "EF50mm f/1.2L USM", "Canon EF 50mm f/1.2L USM"),
            ("Fujifilm", "XF35mmF2 R WR", "XF 35mm f/2 R WR"),
        ]:
            self.assertEqual(canonical(maker, exif), canonical(maker, lf))
    def test_camera_maker_token(self):
        self.assertEqual(canonical("NIKON CORPORATION", "NIKON D850"), canonical("Nikon", "Nikon D850"))

class Conversion(unittest.TestCase):
    def test_ptlens_rescale_matches_liblensfun_rule(self):
        # Sony FE 24-70 f/4 at 24 mm: crop 1, aspect 1.5 → hugin scale = 43.2666/1/1.80278/2 = 12.0 mm; s = 24/12 = 2
        s = 24.0 / hugin_scale_mm(1.0, 1.5)
        self.assertAlmostEqual(s, 2.0, places=6)
        out = convert_distortion("ptlens", dict(a=0.01, b=-0.02, c=0.005), 24.0, 1.0, 1.5)
        d = 1 - 0.01 + 0.02 - 0.005
        self.assertAlmostEqual(out["scale"], d)
        self.assertAlmostEqual(out["even"][0], -0.02 * s**2 / d**3)
        self.assertAlmostEqual(out["odd"][0], 0.005 * s / d**2)
        self.assertAlmostEqual(out["odd"][1], 0.01 * s**3 / d**4)
    def test_poly3_folds_1_minus_k1_into_scale(self):
        out = convert_distortion("poly3", dict(k1=-0.1), 50.0, 1.0, 1.5)
        self.assertAlmostEqual(out["scale"], 1.1)
        self.assertAlmostEqual(out["even"][0], -0.1 * (50.0 / hugin_scale_mm(1.0, 1.5))**2 / 1.1**3)
    def test_vignetting_uses_corner_scale(self):
        k = convert_vignetting("pa", dict(k1=-0.3, k2=0.4, k3=-0.5), 24.0, 1.0)
        s = 24.0 / (math.hypot(36, 24) / 2)
        self.assertAlmostEqual(k[0], -0.3 * s**2); self.assertAlmostEqual(k[1], 0.4 * s**4); self.assertAlmostEqual(k[2], -0.5 * s**6)
    def test_tca_poly3(self):
        red, blue = convert_tca("poly3", dict(vr=1.0002, vb=0.9998, cr=0.0, cb=0.0, br=0.00008, bb=-0.0002), 24.0, 1.0, 1.5)
        s = 24.0 / hugin_scale_mm(1.0, 1.5)
        self.assertEqual(red["scale"], 1.0002); self.assertAlmostEqual(red["even"][0], 0.00008 * s**2)
        self.assertEqual(blue["scale"], 0.9998); self.assertAlmostEqual(blue["even"][0], -0.0002 * s**2)

if __name__ == "__main__": unittest.main()
```

- [ ] **Step 2: Run** — `cd src/scripts && python3 test_convert_lensfun_db.py` → ImportError.

- [ ] **Step 3: Write the converter** (`src/scripts/convert_lensfun_db.py`, argv: `<lensfun-checkout> <out-dir>`), implementing `canonical`, the three `convert_*` above, XML walking with `xml.etree.ElementTree` over `data/db/*.xml` (skip `generic.xml`? No — include it; it has real lenses), the string table, and the writers for `db.bin`, `ATTRIBUTION.md` (title, source repo URL, commit, date, the conversion rules paragraph, then the full CC BY-SA 3.0 text from `docs/cc-by-sa-3.0.txt`) and `COVERAGE.md` (counts per file, total lenses/cameras/mounts, list of skipped entries with reasons, list of lenses whose crop factor differs from every camera on their mount). Keep the script under 570 lines; if the writers push it over, put them in `convert_lensfun_db_write.py` next to it.

- [ ] **Step 4: Run the unit tests** → pass. Then generate: `python3 src/scripts/convert_lensfun_db.py /private/tmp/…/scratchpad/lensfun src/raw-pipeline/raw-core/src/lens_profile/lensfun` and check `ls -la` — `db.bin` is expected around 1 MB; record the exact size in `COVERAGE.md`.

- [ ] **Step 5: Commit** — the script, its test, `db.bin`, `ATTRIBUTION.md`, `COVERAGE.md`: `git commit -m "feat(lens): convert and bundle the Lensfun database (CC BY-SA 3.0)"`.

---

### Task 4: Bundle reader and evaluator parity with `liblensfun`

**Files:**

- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/mod.rs` (`include_bytes!("db.bin")`, `pub fn database() -> &'static Database` via `OnceLock`, `pub struct DatabaseVersion { commit, date }`)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/bundle.rs` (binary parser → `Database { strings, mounts, cameras, lenses }`)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/calibration.rs` (sample → `Calibration` with a `Frame` for a given camera crop and image size)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/tests_bundle.rs`, `tests_parity.rs`
- Modify: `src/raw-pipeline/raw-core/src/lens_profile/mod.rs` (`pub mod lensfun;`)

**Interfaces:**

- Produces:

```rust
pub struct Database { pub version: DatabaseVersion, pub mounts: Vec<Mount>, pub cameras: Vec<Camera>, pub lenses: Vec<Lens> }
pub struct Mount { pub name: String, pub compat: Vec<String> }
pub struct Camera { pub maker: String, pub model: String, pub variants: Vec<String>, pub mount: usize, pub crop: f64 }
pub struct Lens { pub maker: String, pub model: String, pub names: Vec<String>, pub mounts: Vec<usize>, pub crop: f64, pub aspect: f64, pub rectilinear: bool,
                  pub distortion: Vec<DistortionSample>, pub tca: Vec<TcaSample>, pub vignetting: Vec<VignettingSample> }
pub struct DistortionSample { pub focal: f64, pub real_focal: f64, pub scale: f64, pub even: [f64; 3], pub odd: [f64; 2] }
pub struct TcaSample { pub focal: f64, pub real_focal: f64, pub red: RadialTerms, pub blue: RadialTerms }   // RadialTerms { scale, even, odd }
pub struct VignettingSample { pub focal: f64, pub aperture: f64, pub distance: f64, pub k: [f64; 3] }
/// Focal-normalised frame for a calibration on the shooting camera.
pub fn frame(real_focal_mm: f64, camera_crop: f64, width: f64, height: f64) -> Frame
pub fn distortion(sample: &DistortionSample, camera_crop: f64, width: f64, height: f64) -> Perspective
pub fn chromatic(sample: &TcaSample, camera_crop: f64, width: f64, height: f64) -> Chromatic
pub fn vignette(sample: &VignettingSample, camera_crop: f64, width: f64, height: f64) -> Vignette
```

`frame`: the pixel focal length is `f_px = real_focal_mm · camera_crop · hypot(width, height) / hypot(36, 24)` (the sensor diagonal in millimetres is `43.267 / crop`, and the pixel diagonal is `hypot(width, height)`); `Frame { focal: [f_px / max(width, height); 2], center: [0.5, 0.5] }`. Lensfun's `liblensfun` uses `Width − 1` and `Height − 1` for the pixel-centre convention and `Width + 1` inside the hypot; use `width` and `height` as the decoded active-area size in both places and accept the sub-pixel difference — the parity tolerance below is 0.05 px, which covers it at 9504 px wide. If parity fails only because of this, mirror `liblensfun` exactly (`hypot(width + 1, height + 1)` with `width = active_width − 1`) and say so in the module comment.

- [ ] **Step 1: Bundle tests** (`tests_bundle.rs`)

```rust
use super::*;

#[test]
fn bundle_parses_and_counts_match_coverage() {
    let db = database();
    assert_eq!(db.version.commit, "12f5976");
    assert!(db.lenses.len() > 1500 && db.cameras.len() > 1000 && db.mounts.len() > 100, "{} {} {}", db.lenses.len(), db.cameras.len(), db.mounts.len());
    let coverage = include_str!("COVERAGE.md");
    assert!(coverage.contains(&format!("Lenses: {}", db.lenses.len())));
    assert!(coverage.contains(&format!("Cameras: {}", db.cameras.len())));
}

#[test]
fn every_bundled_sample_is_finite_through_the_evaluator() {
    let db = database();
    for lens in &db.lenses {
        for s in &lens.distortion {
            let p = distortion(s, lens.crop, 6000.0, 4000.0);
            for point in [[3000.0, 2000.0], [0.0, 0.0], [5999.0, 3999.0]] {
                let [x, y] = p.map(6000.0, 4000.0, point);
                assert!(x.is_finite() && y.is_finite(), "{} {} focal {}", lens.maker, lens.model, s.focal);
            }
        }
        for s in &lens.vignetting {
            let v = vignette(s, lens.crop, 6000.0, 4000.0);
            assert!(v.gain(6000.0, 4000.0, [0.0, 0.0]).is_some(), "{} {} vignetting at {} f/{}", lens.maker, lens.model, s.focal, s.aperture);
        }
    }
}

#[test]
fn sony_fe_24_70_is_present_with_three_families() {
    let db = database();
    let lens = db.lenses.iter().find(|l| l.model == "FE 24-70mm f/4 ZA OSS").expect("lens");
    assert_eq!(lens.maker, "Sony");
    assert!(db.mounts[lens.mounts[0]].name == "Sony E");
    assert!(!lens.distortion.is_empty() && !lens.tca.is_empty() && !lens.vignetting.is_empty());
}
```

- [ ] **Step 2: Parity tests** (`tests_parity.rs`) — read `test-fixtures/qualification/lensfun-reference.json` with `include_str!` relative path (`../../../../../../test-fixtures/qualification/lensfun-reference.json`) via `serde_json`; for each case find the camera (by maker+model) and lens (by maker+model), pick the samples whose `focal` equals the case focal (exact match, they were chosen that way) and compare:

```rust
#[test]
fn distortion_matches_liblensfun_at_sample_focals() {
    for case in reference().cases {
        let (camera, lens) = find(&case);
        let sample = lens.distortion.iter().find(|s| (s.focal - case.focal).abs() < 1e-6).expect("exact sample focal");
        let p = distortion(sample, camera.crop, case.width as f64, case.height as f64);
        for (point, expected) in case.points.iter().zip(&case.distortion) {
            let got = p.map(case.width as f64, case.height as f64, *point);
            assert!((got[0] - expected[0]).abs() < 0.05 && (got[1] - expected[1]).abs() < 0.05, "{} {} @{}mm point {:?}: got {:?} want {:?}", lens.maker, lens.model, case.focal, point, got, expected);
        }
    }
}
```

Same shape for `tca` (compare red and blue planes through `Chromatic::map(width, height, point, channel)`, tolerance 0.05 px; green must equal the input point) and `vignetting` (`Vignette::gain` is `1 / factor`… careful: `liblensfun`'s `ApplyColorModification` in correction mode multiplies by the _correction_ factor `1 / I(r)`? Verify from the harness output: the centre prints `1.000000`, a corner prints a number `> 1` when the modifier corrects, `< 1` when it applies vignetting. `lfModifier(..., reverse = false)` corrects, so compare `gain` against the printed factor directly with tolerance 1e-4. If corners print `< 1`, compare `1 / gain` and note it.)

The vignetting case uses aperture/distance samples that exist exactly (`aperture="5.6" distance="5"` for the Sony lens at 24 mm — check `grep 'focal="24" aperture="5.6"' data/db/mil-sony.xml`); pick the sample with matching focal, aperture and distance directly, no interpolation.

- [ ] **Step 3: Run** — `cargo test -p raw-core --lib lens_profile::lensfun` → compile errors, then failures.

- [ ] **Step 4: Implement `bundle.rs`, `calibration.rs`, `mod.rs`** per the interfaces; the parser is a plain cursor over `&'static [u8]` with `u16/u32/f32` little-endian reads and a `Result<Database, String>` that names the offset on any short read; `database()` unwraps it once in a `OnceLock` (a malformed bundle is a build defect, not a runtime condition).

- [ ] **Step 5: Run until green**, then `rustfmt --check` on the new files. Iterate on the frame convention only if the parity assertion fails by a systematic factor; a tolerance change is not a fix.

- [ ] **Step 6: Commit** — `git commit -m "feat(lens): read the bundled Lensfun database and reproduce liblensfun's corrections"`.

---

### Task 5: Canonical names and the matcher

**Files:**

- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/names.rs` (`pub fn canonical(maker: &str, name: &str) -> String`, `pub fn canonical_camera(maker: &str, model: &str) -> String`)
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/matcher.rs`
- Create: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/tests_matcher.rs`

**Interfaces:**

- Produces:

```rust
pub struct Match<'a> { pub camera: &'a Camera, pub lens: &'a Lens, pub slug: String }
/// EXIF identity → bundled lens. `None` when either side has no exact canonical match,
/// when the lens is not rectilinear, or when `camera.crop / lens.crop < 0.96`.
pub fn find(db: &Database, make: &str, camera_model: &str, lens_name: &str) -> Option<Match<'_>>
/// Every rectilinear lens on the camera's mount or a mount its mount lists as compatible,
/// for the dropdown. Sorted by maker then model.
pub fn compatible<'a>(db: &'a Database, camera: &Camera) -> Vec<&'a Lens>
/// `lensfun1:<slug>` ↔ lens. slug = canonical(maker, model) + "@" + mount name canonicalised, e.g. `sony/fe24-70mmf4zaoss@sonye`.
pub fn slug(lens: &Lens, mount: &Mount) -> String
pub fn by_slug<'a>(db: &'a Database, slug: &str) -> Option<(&'a Lens, &'a Mount)>
```

`canonical` is the Python rule from the top of this plan, ported verbatim; `canonical_camera` additionally strips a leading token equal to the maker's first token.

- [ ] **Step 1: Tests**

```rust
#[test]
fn exif_and_lensfun_spellings_meet() {
    for (maker, exif, lf) in [("Sony", "FE 24-70mm F4 ZA OSS", "FE 24-70mm f/4 ZA OSS"), ("Canon", "EF70-200mm f/2.8L IS II USM", "Canon EF 70-200mm f/2.8L IS II USM"), ("Canon", "EF50mm f/1.2L USM", "Canon EF 50mm f/1.2L USM"), ("Fujifilm", "XF35mmF2 R WR", "XF 35mm f/2 R WR")] {
        assert_eq!(canonical(maker, exif), canonical(maker, lf), "{exif}");
    }
    assert_eq!(canonical_camera("NIKON CORPORATION", "NIKON D850"), canonical_camera("Nikon", "Nikon D850"));
}

#[test]
fn fixture_identities_resolve_or_are_refused() {
    let db = database();
    let sony = find(db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").expect("sony");
    assert_eq!(sony.lens.model, "FE 24-70mm f/4 ZA OSS");
    assert!(find(db, "Canon", "Canon EOS 5D Mark III", "EF70-200mm f/2.8L IS II USM").is_some());
    assert!(find(db, "Canon", "Canon EOS 5DS R", "EF50mm f/1.2L USM").is_some());
    assert!(find(db, "FUJIFILM", "X-T3", "XF35mmF2 R WR").is_some());
    // Ambiguous EXIF, unknown body, unknown lens: no guess.
    assert!(find(db, "Canon", "Canon EOS 5D Mark IV", "24-70mm").is_none());
    assert!(find(db, "Apple", "iPhone 12 Pro", "iPhone 12 Pro back triple camera 4.2mm f/1.6").is_none());
    assert!(find(db, "Leica Camera AG", "LEICA M10", "Summicron-M 1:2/35 ASPH.").is_none());
}

#[test]
fn a_full_frame_body_does_not_use_an_aps_c_calibration() {
    // FE lens calibrated at crop 1.0 on an APS-C body is fine (ratio 1.5 ≥ 0.96);
    // an APS-C-calibrated lens on a full-frame body is refused (ratio 0.66).
    let db = database();
    let aps = db.lenses.iter().find(|l| l.model == "Sony AF DT 16-105mm f/3.5-5.6").expect("dt lens");
    assert!(aps.crop > 1.4);
    assert!(find(db, "Sony", "ILCE-7RM4", "DT 16-105mm F3.5-5.6").is_none());
}

#[test]
fn slugs_round_trip_and_compatible_lists_the_mount() {
    let db = database();
    let m = find(db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    assert_eq!(m.slug, "sony/fe24-70mmf4zaoss@sonye");
    let (lens, _) = by_slug(db, &m.slug).unwrap();
    assert!(std::ptr::eq(lens, m.lens));
    let list = compatible(db, m.camera);
    assert!(list.iter().any(|l| std::ptr::eq(*l, m.lens)));
    assert!(list.windows(2).all(|w| (w[0].maker.as_str(), w[0].model.as_str()) <= (w[1].maker.as_str(), w[1].model.as_str())));
}
```

The DT 16-105 assertion assumes the Sony Alpha (A-mount) lens is not on the E-mount compat list — verify in `mil-sony.xml` (`<mount><name>Sony E</name><compat>…`); if `Sony Alpha` is listed as compatible, the test still holds because the crop rule refuses it.

- [ ] **Step 2: Run → fail. Step 3: Implement. Step 4: Run → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(lens): match EXIF identity to the bundled Lensfun lens by mount and crop"`.

---

### Task 6: Resolver over Lensfun records and the `lensfun1:` reference

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/lens_profile/resolve.rs` — extract `pub(super) fn resolve_records(records: &[Record], query: &LensQuery) -> Result<Resolution, String>` from `LensProfile::resolve` (the LCP path builds its records then calls it); make `Record` constructible from a Lensfun lens: `Record::lensfun(index, focal, aperture, distance, calibration)`.
- Modify: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/mod.rs` — `pub fn resolve(lens: &Lens, camera_crop: f64, width: f64, height: f64, query: &LensQuery) -> Result<Resolution, String>`: builds one `Record` per distortion sample (aperture = the lens's median vignetting aperture or 0, distance = 1000 m i.e. axis 0.001), one per TCA sample, one per vignetting sample, each carrying only its family in `Calibration`, then `resolve_records`.
- Modify: `src/raw-pipeline/raw-core/src/lens_profile/registry.rs` — `profile_id` becomes `pub enum ProfileRef<'a> { Lcp { id: &'a str, acknowledged: bool }, Lensfun { slug: &'a str } }` with `pub fn parse_reference(reference: &str) -> Result<ProfileRef<'_>, String>`; keep `profile_id` as a thin wrapper for the LCP callers (raw-ffi, CLI) so their code does not change. `resolve_for_raw` handles `Lensfun { slug }` by `by_slug` + `lensfun::resolve` (still `Ok(None)` when `opcode_list3` is present).
- Modify: `Resolution` gains `pub source: Source` with `pub enum Source { Lcp, Lensfun { maker: String, model: String, db_version: String } }`; `Resolution::metadata()` (the JSON hosts display) adds `"source": "lensfun"`, `"lens"`, `"dbVersion"`.
- Test: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/tests_resolve.rs`

**Interfaces:**

- Produces: `parse_reference`, `ProfileRef`, `lensfun::resolve`, `Source`.

- [ ] **Step 1: Tests**

```rust
#[test]
fn lensfun_reference_resolves_the_sony_lens_with_all_families() {
    let raw = sony_raw_stub(); // RawImage as in tests_registry::raw() but make "SONY", model "ILCE-7RM4", lens "FE 24-70mm F4 ZA OSS", focal 35, aperture 5.6, no opcode_list3, 9504×6336
    let res = resolve_for_raw(&raw, "lensfun1:sony/fe24-70mmf4zaoss@sonye").unwrap().expect("resolution");
    assert!(matches!(res.source, Source::Lensfun { .. }));
    assert!(res.calibration.distortion.is_some() && res.calibration.ca.is_some() && res.calibration.vignette.is_some());
    assert!(res.approximations.is_empty(), "{:?}", res.approximations);
}

#[test]
fn embedded_opcodes_still_win_over_a_lensfun_reference() {
    let mut raw = sony_raw_stub();
    raw.opcode_list3 = Some((OpcodeList3 { opcodes: vec![], skipped_unknown: 0 }, ActiveAreaRect::full(raw.width, raw.height)));
    assert!(resolve_for_raw(&raw, "lensfun1:sony/fe24-70mmf4zaoss@sonye").unwrap().is_none());
}

#[test]
fn unknown_slug_and_wrong_version_are_errors() {
    let raw = sony_raw_stub();
    assert!(resolve_for_raw(&raw, "lensfun1:sony/nosuchlens@sonye").is_err());
    assert!(parse_reference("lensfun2:x").is_err());
    assert!(matches!(parse_reference("lcp1-ack:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap(), ProfileRef::Lcp { acknowledged: true, .. }));
}

#[test]
fn out_of_range_focal_is_an_approximation_not_a_rejection() {
    let mut raw = sony_raw_stub();
    raw.focal_length = Some(300.0);
    let res = resolve_for_raw(&raw, "lensfun1:sony/fe24-70mmf4zaoss@sonye").unwrap().unwrap();
    assert!(res.approximations.iter().any(|a| a.contains("focal")));
}
```

- [ ] **Step 2: Run → fail. Step 3: Implement. Step 4: Run the whole `lens_profile` module, including the LCP tests, → pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(lens): resolve bundled Lensfun calibrations through the LCP resolver and the lensfun1: reference"`.

Slice 1 (#3565) is complete after this task: open the PR (`Closes #3565`, `Part of #3564`) with the reference-vector counts, the bundle size, and `cargo test -p raw-core --lib lens_profile` totals in the body.

---

### Task 7: Automatic matching in the develop path

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/lens_profile/registry.rs` — `apply_for_raw`: when `model.lens_profile.is_empty()`, call `lensfun::auto_match(raw)`; `pub fn auto_match(raw: &RawImage) -> Option<Match<'static>>` uses `find(database(), make, camera, lens)` from `raw.lens_metadata` (same fallbacks as `resolve_for_raw`'s query).
- Modify: `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs` and `develop_sized.rs` — the branch `else if !model.lens_profile.is_empty()` becomes `else if lens_profile::applies(raw, model)` where `applies` = `!model.lens_profile.is_empty() || lensfun::auto_match(raw).is_some()` and the scales are not `NONE`.
- Modify: `src/raw-pipeline/raw-core/src/lens_profile/mod.rs` — `pub fn evidence_for(raw, model) -> Option<serde_json::Value>` returning the same JSON `resolve_for_raw` metadata produces, now for the automatic match too (used by raw-ffi `maple_lens_profile_resolve_file` and wasm `metadata`, which call it instead of `resolve_for_raw(raw, &model.lens_profile)` directly).
- Test: `src/raw-pipeline/raw-core/src/lens_profile/lensfun/tests_auto.rs`

- [ ] **Step 1: Tests**

```rust
#[test]
fn auto_match_applies_without_a_sidecar_reference_and_master_off_disables_it() {
    let raw = sony_raw_stub_with_pixels(); // 64×64 LinearRgb gradient so a warp changes pixels
    let base = develop_scene_linear_from_raw_with_quality(&raw, &AdjustmentModel::default(), RenderQuality::Full).unwrap();
    let mut off = AdjustmentModel::default();
    off.lens_profile_enable = LensProfileEnable::Off;
    let untouched = develop_scene_linear_from_raw_with_quality(&raw, &off, RenderQuality::Full).unwrap();
    assert_ne!(base.pixels, untouched.pixels, "auto match must change pixels when on");
}

#[test]
fn an_explicit_lcp_selection_beats_the_auto_match() { /* register the synthetic LCP from tests_registry, set model.lens_profile = reference(), assert evidence_for reports source "lcp" */ }

#[test]
fn no_match_means_no_correction_and_no_error() {
    let raw = canon_24_70_stub(); // lens "24-70mm"
    let model = AdjustmentModel::default();
    assert!(evidence_for(&raw, &model).is_none());
    develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full).unwrap();
}
```

- [ ] **Step 2–4: fail → implement → pass** (`cargo test -p raw-core --lib lens_profile`, then `cargo test -p raw-core --lib` in full).

- [ ] **Step 5: Colour evidence.** Symlink the fixtures (`ln -s /Users/riabuz/Projects/_Maple/test-fixtures/raws test-fixtures/raws`), run `src/scripts/test_color_pipeline.sh` in full and save the per-fixture table to `~/Desktop/maple-color-tests/3566/`. Expected: fixtures with a Lensfun match (test_0003, 0006, 0007, 0008, 0011) move; all others byte-identical. For every moved fixture record mean/p95/max before and after in the PR. If a budget is exceeded, do not raise it: report the fixture and stop — whether ACR's reference had lens correction on is a question for the owner.

- [ ] **Step 6: Commit** — `git commit -m "feat(lens): apply the matched Lensfun calibration automatically in the develop path"`.

---

### Task 8: CLI flag and evidence in the hosts' JSON

**Files:**

- Modify: `src/raw-pipeline/maple-cli/src/commands/render_lens.rs` — `LensProfileArgs` gains `#[arg(long, value_name = "auto|off|<slug>")] lens: Option<String>`; `apply_lens_profile_selection` handles it: `off` sets `lens_profile_enable = Off`, `auto` leaves the model, `<slug>` sets `lens_profile = format!("lensfun1:{slug}")` after `by_slug` validates it; `report_lens_resolution` prints `evidence_for`.
- Modify: `src/raw-pipeline/raw-ffi/src/lens_profile.rs` — `maple_lens_profile_resolve_file` returns `evidence_for`; add `maple_lens_profile_compatible(path, out_json)` returning `[{"slug","maker","model"}]` for the dropdown (slice 3 needs it; it is three lines here).
- Modify: `src/raw-pipeline/raw-wasm/src/lens_profile.rs` — `metadata()` uses `evidence_for`; export `compatibleLensProfiles(raw, ext)`.
- Test: `cargo test -p maple-cli`, `cargo test -p raw-ffi --lib lens_profile`, `cargo test -p raw-wasm --lib lens_profile`.

- [ ] **Steps: add a CLI test in `render_lens.rs` that `--lens off` produces `LensProfileEnable::Off` and `--lens sony/fe24-70mmf4zaoss@sonye` produces the `lensfun1:` reference; an FFI test that `maple_lens_profile_compatible` on the synthetic grey DNG (no match) returns `[]`. Implement, run, `cargo fmt -p raw-ffi`, commit `feat(lens): --lens auto|off|<slug> and Lensfun evidence for every host`.**

---

### Task 9: Gate — Lensfun against the Adobe LCP for the same lens

**Files:**

- Create: `src/scripts/test_lensfun_vs_lcp.sh`
- Create: `src/scripts/lens_warp_diff.py`
- Create: `test-fixtures/qualification/lensfun-vs-lcp.json` (recorded ceilings)
- Modify: `src/raw-pipeline/maple-cli/src/commands/render_lens.rs` — `maple-cli lens-warp <raw> [--lens …|--lens-profile …] --out <json>`: dumps the source coordinates of a 17×11 grid of output points for the resolved calibration (`Perspective::map` / `Chromatic::map`) and the vignetting gain at each, as JSON. Under 570 lines: if `render_lens.rs` passes 500, put the subcommand in `commands/lens_warp.rs`.

The gate renders nothing; it compares the two warp fields directly, which is exact and fast:

```bash
# src/scripts/test_lensfun_vs_lcp.sh — skips when the RAW or the Adobe LCP is absent (both gitignored/local-only).
RAW=test-fixtures/raws/test_0011.ARW
LCP="/Library/Application Support/Adobe/CameraRaw/LensProfiles/1.0/Sony/SONY (Sony FE 24-70mm F4 ZA OSS) - RAW.lcp"
[ -f "$RAW" ] && [ -f "$LCP" ] || { echo "lensfun-vs-lcp: fixtures absent, skipping"; exit 0; }
cargo run --release --bin maple-cli -- lens-warp "$RAW" --lens auto --out /tmp/lf.json
cargo run --release --bin maple-cli -- lens-warp "$RAW" --lens-profile "$LCP" --acknowledge-lens-approximation --out /tmp/lcp.json
python3 src/scripts/lens_warp_diff.py /tmp/lf.json /tmp/lcp.json test-fixtures/qualification/lensfun-vs-lcp.json
```

`lens_warp_diff.py` reports, per family: the mean and max displacement difference in pixels (distortion; red/blue TCA relative to green) and the mean and max gain ratio difference (vignetting), and fails when any exceeds the recorded ceiling. First run: print the numbers, set ceilings 10 % above them, commit. Expected order of magnitude from the two independent calibrations of the same lens: distortion within a few pixels at the corners of a 9504-px frame, TCA within 0.5 px, vignetting gain within 3 %. If the distortion difference is tens of pixels, the frame convention in Task 4 is wrong even though the `liblensfun` parity passed — stop and report rather than record the ceiling.

- [ ] **Commit** — `git commit -m "test(lens): gate the Lensfun calibration against the Adobe LCP for the same lens"`; wire the script into `.github/workflows/raw-pipeline.yml` next to `color-pipeline` (it skip-passes in CI without fixtures, like the others).

---

### Task 10: Docs

**Files:**

- Modify: `docs/lens-profiles.md` — new first section "Bundled Lensfun database": what is bundled, licence, matching rules, precedence, the `lensfun1:` reference, `--lens`; the LCP import becomes the override section.
- Modify: `docs/caching.md` — nothing changes in the decode key (the match is a function of the RAW), state that explicitly in the lens_profile sentence.
- Modify: `docs/testing.md` — the two new gates (`lensfun-reference.json` parity, `test_lensfun_vs_lcp.sh`).

- [ ] **Commit** — `docs(lens): bundled Lensfun corrections`. Open the slice-2 PR (`Closes #3566`, `Part of #3564`) with the colour-evidence table from Task 7 and the gate numbers from Task 9.

---

## Self-review

- Spec coverage: source data → Task 3; coordinate conversion → Tasks 2–4; matching → Task 5; precedence and persistence → Tasks 6–7; bundle and attribution → Task 3; slice-2 gate → Task 9; evidence fields → Task 8; docs → Task 10. Dropdown UI is slice 3, out of this plan.
- Names used consistently: `canonical`, `canonical_camera`, `find`, `compatible`, `slug`, `by_slug`, `database()`, `frame`, `distortion`, `chromatic`, `vignette`, `resolve_records`, `parse_reference`, `ProfileRef`, `Source`, `evidence_for`, `auto_match`, `LensProfileArgs.lens`.
- Open risk: the pixel-centre convention (`Width − 1`) is called out in Task 4 with the fallback; the ACR-reference question is called out in Task 7 as a stop-and-report, not a budget change.
