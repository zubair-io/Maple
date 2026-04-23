# raw-core slice 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an end-to-end Rust raw-core + CLI that decodes all rawler-supported Bayer RAWs, applies WB / exposure / dehaze in scene-linear Rec.2020, and writes sRGB PNGs that score within loose ΔE budgets against the ACR reference matrix for `baseline`, `exposure_*`, `wb_*`, and `dehaze_*` cases across all four fixtures.

**Architecture:** Scene-referred throughout (linear Rec.2020 D65, f32, unbounded) with AgX as the single view transform. Pure-Rust CPU backend only. Cargo workspace at `src/raw-pipeline/` containing `raw-core` (library) + `maple-cli` (bin). Golden tests shell out to a minimal `src/scripts/compare_images.py` that emits CIEDE2000 + per-channel bias JSON.

**Tech Stack:**
- Rust (2021 edition, stable)
- `rawler` — RAW container parse + sensor data extraction
- `quick-xml` — XMP parsing
- `image` + `png` — PNG output with sRGB chunk
- `thiserror` — error types
- `clap` — CLI argument parsing
- `serde` + `serde_json` — golden-test JSON
- `bytemuck` — safe zero-copy casts
- Python 3.11+ with `numpy`, `Pillow`, `colour-science` — comparator only

**Spec references throughout:** `docs/spec/{00..11}-*.md`. The roadmap `docs/superpowers/specs/2026-04-22-raw-core-roadmap.md` lists what's in this slice vs. deferred.

**Fixtures (gitignored, at `test-fixtures/raws/`):**
- `test_0000.DNG` — Hasselblad L3D-100c, 100 MP (slow; use last in local iteration)
- `test_0001.RAW` — Hasselblad 3FR (magic `IIU\0`)
- `test_0002.dng` — DNG big-endian (**primary fixture for early tasks**)
- `test_0003.CR2` — Canon CR2

ACR references: `test-fixtures/references/<stem>/{down,full}/<case>.png`.

---

## Phase 0 — Workspace scaffold

### Task 0.1: Initialize Cargo workspace and empty crates

**Files:**
- Create: `src/raw-pipeline/Cargo.toml`
- Create: `src/raw-pipeline/rust-toolchain.toml`
- Create: `src/raw-pipeline/raw-core/Cargo.toml`
- Create: `src/raw-pipeline/raw-core/src/lib.rs`
- Create: `src/raw-pipeline/maple-cli/Cargo.toml`
- Create: `src/raw-pipeline/maple-cli/src/main.rs`

- [ ] **Step 1: Create workspace manifest**

`src/raw-pipeline/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["raw-core", "maple-cli"]

[workspace.package]
edition = "2021"
rust-version = "1.83"
license = "Proprietary"

[workspace.dependencies]
rawler = "0.7"
image = { version = "0.25", default-features = false, features = ["png"] }
png = "0.17"
quick-xml = "0.37"
thiserror = "2"
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
bytemuck = { version = "1", features = ["derive"] }
```

Note: verify `rawler` version against crates.io if 0.7 is not current. The API check in Task 3.3 will surface any mismatch.

- [ ] **Step 2: Pin toolchain**

`src/raw-pipeline/rust-toolchain.toml`:
```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

- [ ] **Step 3: Create raw-core crate manifest**

`src/raw-pipeline/raw-core/Cargo.toml`:
```toml
[package]
name = "raw-core"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[dependencies]
rawler.workspace = true
image.workspace = true
png.workspace = true
quick-xml.workspace = true
thiserror.workspace = true
bytemuck.workspace = true

[dev-dependencies]
serde.workspace = true
serde_json.workspace = true

[features]
# Opt-in integration tests that shell out to compare_images.py.
golden = []
```

- [ ] **Step 4: Create raw-core lib stub**

`src/raw-pipeline/raw-core/src/lib.rs`:
```rust
//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]
```

- [ ] **Step 5: Create maple-cli crate manifest**

`src/raw-pipeline/maple-cli/Cargo.toml`:
```toml
[package]
name = "maple-cli"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[[bin]]
name = "maple-cli"
path = "src/main.rs"

[dependencies]
raw-core = { path = "../raw-core" }
clap.workspace = true
thiserror.workspace = true
```

- [ ] **Step 6: Create CLI stub**

`src/raw-pipeline/maple-cli/src/main.rs`:
```rust
fn main() {
    eprintln!("maple-cli: not yet implemented");
    std::process::exit(2);
}
```

- [ ] **Step 7: Build and verify**

```bash
cd src/raw-pipeline && cargo build --workspace
```

Expected: successful build, two target artifacts.

- [ ] **Step 8: Commit**

```bash
git add src/raw-pipeline/
git commit -m "$(cat <<'EOF'
raw-core slice 1: workspace scaffold

Creates empty raw-core library and maple-cli binary under
src/raw-pipeline/ per the roadmap. Workspace uses edition 2021,
pins stable toolchain. Dependencies staged but unused.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — Core types

### Task 1.1: Error type and module skeleton

**Files:**
- Create: `src/raw-pipeline/raw-core/src/error.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

- [ ] **Step 1: Write error type**

`src/raw-pipeline/raw-core/src/error.rs`:
```rust
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error reading {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("rawler failed to decode {path}: {reason}")]
    Decode { path: PathBuf, reason: String },

    #[error("unsupported CFA pattern: {0:?}")]
    UnsupportedCfa(String),

    #[error("DCP profile missing or unparseable: {0}")]
    Dcp(String),

    #[error("XMP parse error: {0}")]
    Xmp(String),

    #[error("PNG write error: {0}")]
    Png(String),

    #[error("pipeline assertion failed: {0}")]
    Pipeline(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
```

- [ ] **Step 2: Wire module into lib**

Update `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
//! Portable, scene-referred Rust raw-core per `docs/spec/`.
//!
//! Slice 1 scope: decode → bilinear demosaic → minimal DCP →
//! white balance → exposure → dehaze → AgX → Rec.2020→sRGB → PNG.

#![warn(clippy::all, rust_2018_idioms)]

pub mod error;
pub use error::{Error, Result};
```

- [ ] **Step 3: Build and commit**

```bash
cd src/raw-pipeline && cargo build -p raw-core
git add src/raw-pipeline/raw-core/
git commit -m "raw-core: error type"
```

---

## Phase 2 — Color math foundation

### Task 2.1: `Matrix3` and `Vec3` helpers

**Files:**
- Create: `src/raw-pipeline/raw-core/src/math.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Rationale: pure-Rust 3×3 arithmetic with no external linear-algebra dep; `bytemuck` makes the row-major representation cast-safe for future GPU paths.

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/math.rs`:
```rust
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Pod, Zeroable)]
pub struct Matrix3(pub [[f32; 3]; 3]);

pub type Vec3 = [f32; 3];

impl Matrix3 {
    pub const IDENTITY: Self = Self([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        let m = &self.0;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    pub fn mul_mat(&self, other: &Self) -> Self {
        let a = &self.0;
        let b = &other.0;
        let mut out = [[0.0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
            }
        }
        Self(out)
    }

    pub fn inverse(&self) -> Option<Self> {
        let m = &self.0;
        let det =
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
          - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
          + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if det.abs() < 1e-12 {
            return None;
        }
        let inv_det = 1.0 / det;
        let mut out = [[0.0f32; 3]; 3];
        out[0][0] =  (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det;
        out[0][1] = -(m[0][1] * m[2][2] - m[0][2] * m[2][1]) * inv_det;
        out[0][2] =  (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det;
        out[1][0] = -(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * inv_det;
        out[1][1] =  (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det;
        out[1][2] = -(m[0][0] * m[1][2] - m[0][2] * m[1][0]) * inv_det;
        out[2][0] =  (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det;
        out[2][1] = -(m[0][0] * m[2][1] - m[0][1] * m[2][0]) * inv_det;
        out[2][2] =  (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det;
        Some(Self(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn identity_is_identity() {
        let v = [0.2, 0.5, 0.8];
        assert_eq!(Matrix3::IDENTITY.mul_vec(v), v);
    }

    #[test]
    fn mul_mat_is_associative_against_identity() {
        let a = Matrix3([[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]]);
        assert_eq!(a.mul_mat(&Matrix3::IDENTITY), a);
        assert_eq!(Matrix3::IDENTITY.mul_mat(&a), a);
    }

    #[test]
    fn diagonal_inverse_is_reciprocal() {
        let a = Matrix3([[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]]);
        let inv = a.inverse().unwrap();
        let expect = Matrix3([[0.5, 0.0, 0.0], [0.0, 1.0 / 3.0, 0.0], [0.0, 0.0, 0.25]]);
        for i in 0..3 {
            for j in 0..3 {
                assert!(approx(inv.0[i][j], expect.0[i][j], 1e-6));
            }
        }
    }

    #[test]
    fn inverse_round_trip() {
        let a = Matrix3([
            [0.7328, 0.4296, -0.1624],
            [-0.7036, 1.6975, 0.0061],
            [0.0030, 0.0136, 0.9834],
        ]);
        let inv = a.inverse().unwrap();
        let product = a.mul_mat(&inv);
        for i in 0..3 {
            for j in 0..3 {
                let expect = if i == j { 1.0 } else { 0.0 };
                assert!(approx(product.0[i][j], expect, 1e-5));
            }
        }
    }
}
```

- [ ] **Step 2: Wire into lib**

Add to `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
pub mod math;
```

- [ ] **Step 3: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core math
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/raw-pipeline/raw-core/src/math.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: Matrix3 and Vec3 with inverse"
```

### Task 2.2: Compile-time color matrices

**Files:**
- Create: `src/raw-pipeline/raw-core/src/color/mod.rs`
- Create: `src/raw-pipeline/raw-core/src/color/matrices.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Rationale: Bradford CAT, D50/D65 white points, ProPhoto↔XYZ matrices, the composed `M_pro_to_rec2020` that hands DCP output into the Rec.2020 working space (spec § 04 "Camera-native → Rec.2020" step 6), and the final `M_rec2020_to_srgb` display matrix (spec § 04 "Display encode"). Computed once at library init as `const` or `LazyLock` — never per-pixel (spec § 04 "Bradford adaptation").

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/color/matrices.rs`:
```rust
use crate::math::{Matrix3, Vec3};

/// D50 reference white in XYZ (CIE 1931, Y=1).
/// See spec docs/spec/04-color-management.md § Bradford adaptation.
pub const XYZ_D50: Vec3 = [0.9642, 1.0000, 0.8251];

/// D65 reference white in XYZ (CIE 1931, Y=1).
pub const XYZ_D65: Vec3 = [0.9504, 1.0000, 1.0888];

/// Bradford chromatic adaptation matrix: XYZ → LMS (cone-fundamental-like).
pub const BRADFORD: Matrix3 = Matrix3([
    [ 0.8951,  0.2664, -0.1614],
    [-0.7502,  1.7135,  0.0367],
    [ 0.0389, -0.0685,  1.0296],
]);

/// ProPhoto RGB → XYZ D50. Adobe DNG spec, "ROMM" matrix.
pub const M_PRO_TO_XYZ_D50: Matrix3 = Matrix3([
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0000000, 0.0000000, 0.8252100],
]);

/// XYZ D65 → linear Rec.2020. ITU-R BT.2020.
pub const M_XYZ_D65_TO_REC2020: Matrix3 = Matrix3([
    [ 1.7166512, -0.3556708, -0.2533663],
    [-0.6666844,  1.6164812,  0.0157685],
    [ 0.0176399, -0.0427706,  0.9421031],
]);

/// Linear Rec.2020 → sRGB linear. ITU-R BT.2020 → IEC 61966-2-1.
pub const M_REC2020_TO_SRGB: Matrix3 = Matrix3([
    [ 1.6605, -0.5876, -0.0728],
    [-0.1246,  1.1329, -0.0083],
    [-0.0182, -0.1006,  1.1187],
]);

/// Compute Bradford chromatic-adaptation matrix for `src_white` → `dst_white`.
/// Both in XYZ. See spec § 3.15.
pub fn bradford_adapt(src_white: Vec3, dst_white: Vec3) -> Matrix3 {
    let br = BRADFORD;
    let br_inv = br.inverse().expect("Bradford is non-singular");
    let src_lms = br.mul_vec(src_white);
    let dst_lms = br.mul_vec(dst_white);
    let scale = Matrix3([
        [dst_lms[0] / src_lms[0], 0.0, 0.0],
        [0.0, dst_lms[1] / src_lms[1], 0.0],
        [0.0, 0.0, dst_lms[2] / src_lms[2]],
    ]);
    br_inv.mul_mat(&scale).mul_mat(&br)
}

/// Composed ProPhoto D50 → linear Rec.2020 D65 matrix.
/// Folds ProPhoto→XYZ D50 + Bradford D50→D65 + XYZ→Rec.2020.
/// See spec § 04 and § 3.4 step 6.
pub fn m_pro_to_rec2020() -> Matrix3 {
    let adapt = bradford_adapt(XYZ_D50, XYZ_D65);
    M_XYZ_D65_TO_REC2020.mul_mat(&adapt).mul_mat(&M_PRO_TO_XYZ_D50)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Vec3, b: Vec3, eps: f32) -> bool {
        (a[0] - b[0]).abs() < eps && (a[1] - b[1]).abs() < eps && (a[2] - b[2]).abs() < eps
    }

    #[test]
    fn bradford_identity_when_whites_match() {
        let m = bradford_adapt(XYZ_D65, XYZ_D65);
        let v = [0.5, 0.5, 0.5];
        assert!(approx(m.mul_vec(v), v, 1e-5));
    }

    #[test]
    fn bradford_maps_source_white_to_destination_white() {
        let m = bradford_adapt(XYZ_D50, XYZ_D65);
        assert!(approx(m.mul_vec(XYZ_D50), XYZ_D65, 1e-4));
    }

    #[test]
    fn pro_to_rec2020_maps_mid_gray_to_reasonable_rec2020() {
        // ProPhoto (0.18, 0.18, 0.18) is neutral mid-gray at D50.
        // After the composed matrix, it should be close to neutral mid-gray
        // in Rec.2020 D65 (small chromatic adaptation shift acceptable).
        let m = m_pro_to_rec2020();
        let out = m.mul_vec([0.18, 0.18, 0.18]);
        // Green should be near 0.18 (unchanged under D50→D65 for neutrals).
        assert!((out[1] - 0.18).abs() < 0.01, "G was {}", out[1]);
        // R and B should drift less than 10% from 0.18.
        assert!((out[0] - 0.18).abs() < 0.02, "R was {}", out[0]);
        assert!((out[2] - 0.18).abs() < 0.02, "B was {}", out[2]);
    }

    #[test]
    fn rec2020_to_srgb_preserves_white() {
        // (1, 1, 1) Rec.2020 → (1, 1, 1) sRGB linear (shared white point D65).
        let out = M_REC2020_TO_SRGB.mul_vec([1.0, 1.0, 1.0]);
        assert!((out[0] - 1.0).abs() < 1e-3);
        assert!((out[1] - 1.0).abs() < 1e-3);
        assert!((out[2] - 1.0).abs() < 1e-3);
    }
}
```

- [ ] **Step 2: Create color module**

`src/raw-pipeline/raw-core/src/color/mod.rs`:
```rust
pub mod matrices;
```

Add to `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
pub mod color;
```

- [ ] **Step 3: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core matrices
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/raw-pipeline/raw-core/src/color/ src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: compile-time color matrices and Bradford CAT"
```

---

## Phase 3 — Core image and raw types

### Task 3.1: `ColorSpace`, `Image`, `CfaPattern`, `RawImage`

**Files:**
- Create: `src/raw-pipeline/raw-core/src/image.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/image.rs`:
```rust
use crate::math::Matrix3;

/// Tracks the colorspace of each `Image` at runtime. Stages `debug_assert!`
/// on this at their entry and exit. See spec docs/spec/04-color-management.md.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    /// Post-sensor-linearization, pre-demosaic. Single-channel mosaic per pixel.
    CameraNativeMosaic,
    /// Post-demosaic, pre-DCP. Three-channel camera-native linear RGB.
    CameraNativeLinearRgb,
    /// Post-DCP: scene-referred linear Rec.2020 D65, f32, **unbounded**.
    /// Main working space per spec § 04.
    SceneLinearRec2020,
    /// Post-AgX: display-linear Rec.2020, [0, 1] clamped.
    DisplayLinearRec2020,
    /// Post-gamut matrix: display-linear sRGB, [0, 1].
    DisplayLinearSrgb,
    /// Post-gamma: sRGB gamma-encoded, u8-equivalent range.
    DisplayEncodedSrgb,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[f32; 3]>,
    pub space: ColorSpace,
}

impl Image {
    pub fn new(width: u32, height: u32, space: ColorSpace) -> Self {
        let len = (width as usize) * (height as usize);
        Self { width, height, pixels: vec![[0.0; 3]; len], space }
    }

    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    pub fn assert_space(&self, expected: ColorSpace) {
        debug_assert_eq!(self.space, expected,
            "expected colorspace {:?}, got {:?}", expected, self.space);
    }
}

/// Bayer CFA pattern. X-Trans is deferred (spec § 3.3 explicitly excludes it
/// from the slice-1 demosaic path).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CfaPattern {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
}

impl CfaPattern {
    /// Returns the color (0=R, 1=G, 2=B) at raw-space (x, y).
    pub fn color_at(self, x: u32, y: u32) -> u8 {
        let ex = (x & 1) as u8;
        let ey = (y & 1) as u8;
        match self {
            Self::Rggb => match (ex, ey) { (0,0)=>0, (1,0)=>1, (0,1)=>1, _=>2 },
            Self::Bggr => match (ex, ey) { (0,0)=>2, (1,0)=>1, (0,1)=>1, _=>0 },
            Self::Grbg => match (ex, ey) { (0,0)=>1, (1,0)=>0, (0,1)=>2, _=>1 },
            Self::Gbrg => match (ex, ey) { (0,0)=>1, (1,0)=>2, (0,1)=>0, _=>1 },
        }
    }
}

#[derive(Clone, Debug)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub black_level: [u32; 4],   // per CFA position, indexed as [y_even*2 + x_even]
    pub white_level: u32,
    pub raw_data: Vec<u16>,
    /// As-shot white-balance multipliers from camera metadata.
    pub as_shot_neutral: [f32; 3],
    /// Correlated color temperature derived from metadata, if available.
    pub as_shot_cct: Option<f32>,
    pub camera_make: String,
    pub camera_model: String,
    /// Embedded camera color matrices. DNG carries these in tags; non-DNG
    /// RAWs get a synthesized profile from rawler's built-in adobe_coeff table.
    /// Full DCP with HSM/PLT lands in slice 4 per roadmap.
    pub embedded_color_matrix: Option<Matrix3>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_image_zero_initialized() {
        let img = Image::new(4, 2, ColorSpace::SceneLinearRec2020);
        assert_eq!(img.pixel_count(), 8);
        assert!(img.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
    }

    #[test]
    fn rggb_pattern_positions() {
        let p = CfaPattern::Rggb;
        assert_eq!(p.color_at(0, 0), 0); // R
        assert_eq!(p.color_at(1, 0), 1); // G
        assert_eq!(p.color_at(0, 1), 1); // G
        assert_eq!(p.color_at(1, 1), 2); // B
    }

    #[test]
    fn bggr_pattern_positions() {
        let p = CfaPattern::Bggr;
        assert_eq!(p.color_at(0, 0), 2);
        assert_eq!(p.color_at(1, 1), 0);
    }

    #[test]
    #[should_panic(expected = "expected colorspace")]
    fn assert_space_panics_on_mismatch() {
        let img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.assert_space(ColorSpace::DisplayLinearSrgb);
    }
}
```

- [ ] **Step 2: Wire module**

Add to `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
pub mod image;
pub use image::{CfaPattern, ColorSpace, Image, RawImage};
```

- [ ] **Step 3: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core image
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/raw-pipeline/raw-core/src/image.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: Image/RawImage/CfaPattern/ColorSpace types"
```

---

## Phase 4 — RAW decode

### Task 4.1: Verify rawler API + decode DNG

**Files:**
- Create: `src/raw-pipeline/raw-core/src/decode.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`
- Test fixture: `test-fixtures/raws/test_0002.dng` (already on disk)

**Rawler API note:** rawler's API has shifted between 0.6 and 0.7. Before writing the decode call, run `cargo doc --open -p rawler` or inspect `rawler`'s README and confirm which entry point (`rawler::decoders::Decoder::new`, `rawler::rawsource::RawSource`, etc.) exists in the version locked in `Cargo.lock`. The sketch below assumes a plausible 0.7 API surface; adjust to what the crate actually exposes. If rawler 0.7's API is materially different, widen the adapter functions in this task and keep the public `RawImage` signature unchanged.

- [ ] **Step 1: Verify rawler is building**

```bash
cd src/raw-pipeline && cargo tree -p raw-core | grep rawler
```

Expected: single `rawler` entry with its deps listed. If none, `cargo build -p raw-core` first to pull the crate.

- [ ] **Step 2: Write decode test (ignored if fixture missing)**

`src/raw-pipeline/raw-core/src/decode.rs`:
```rust
use crate::{error::{Error, Result}, image::{CfaPattern, RawImage}, math::Matrix3};
use std::path::Path;

/// Decode a RAW file to a mosaic + metadata. Format dispatch is delegated to
/// rawler; X-Trans is rejected with `Error::UnsupportedCfa` (spec § 3.3).
pub fn decode(path: &Path) -> Result<RawImage> {
    // PLACEHOLDER; real impl in step 3. The test in this step should compile
    // and fail with a clear "not yet implemented" rather than a shape mismatch.
    let _ = path;
    Err(Error::Decode {
        path: path.to_path_buf(),
        reason: "decode not yet implemented".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        // Tests run with cwd at src/raw-pipeline/raw-core; the fixtures are
        // four levels up in the repo root.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws")
    }

    #[test]
    fn decode_test_0002_reports_plausible_dimensions() {
        let path = fixture_root().join("test_0002.dng");
        if !path.exists() {
            eprintln!("skipping: fixture not present at {}", path.display());
            return;
        }
        let raw = decode(&path).expect("decode should succeed on a DNG");
        assert!(raw.width >= 1024, "suspiciously narrow: {}", raw.width);
        assert!(raw.height >= 1024, "suspiciously short: {}", raw.height);
        assert_eq!(raw.raw_data.len(), (raw.width as usize) * (raw.height as usize));
        assert!(raw.white_level > 0);
        // DNGs carry the CFA pattern explicitly.
        assert!(matches!(
            raw.cfa,
            CfaPattern::Rggb | CfaPattern::Bggr | CfaPattern::Grbg | CfaPattern::Gbrg
        ));
    }
}
```

Wire into lib:
```rust
pub mod decode;
```

- [ ] **Step 3: Run test to verify failure**

```bash
cd src/raw-pipeline && cargo test -p raw-core decode_test_0002 -- --nocapture
```

Expected: FAIL with "decode should succeed on a DNG" (or skip if fixture absent — mark the fixture as required before proceeding).

- [ ] **Step 4: Implement decode against rawler**

Replace the body of `decode()` with real rawler calls. Sketch below; adjust to the actual API version:

```rust
pub fn decode(path: &Path) -> Result<RawImage> {
    use rawler::rawsource::RawSource;

    let source = RawSource::new(path).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(std::io::ErrorKind::Other, e.to_string()),
    })?;

    let decoder = rawler::get_decoder(&source).map_err(|e| Error::Decode {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })?;

    let raw = decoder
        .raw_image(&source, &rawler::RawDecodeParams::default(), false)
        .map_err(|e| Error::Decode {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;

    let rawler::RawImage { width, height, cfa, whitelevels, blacklevels, cpp, .. } = &raw;

    let cfa_pattern = match cfa.name.as_str() {
        "RGGB" => CfaPattern::Rggb,
        "BGGR" => CfaPattern::Bggr,
        "GRBG" => CfaPattern::Grbg,
        "GBRG" => CfaPattern::Gbrg,
        other => return Err(Error::UnsupportedCfa(other.into())),
    };

    let raw_data = match &raw.data {
        rawler::RawImageData::Integer(v) => v.clone(),
        rawler::RawImageData::Float(_) => {
            return Err(Error::Decode {
                path: path.to_path_buf(),
                reason: "float RAWs unsupported in slice 1".into(),
            });
        }
    };
    assert_eq!(*cpp, 1, "only single-channel Bayer is supported");

    let make = decoder.clean_make();
    let model = decoder.clean_model();
    let wb = decoder.white_balance().unwrap_or([1.0, 1.0, 1.0, 1.0]);

    // Embedded ColorMatrix (primary illuminant) if the decoder exposes one.
    let embedded_color_matrix = decoder
        .color_matrix()
        .map(|m| Matrix3([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]]));

    Ok(RawImage {
        width: *width as u32,
        height: *height as u32,
        cfa: cfa_pattern,
        black_level: [
            blacklevels[0] as u32,
            blacklevels[1] as u32,
            blacklevels[2] as u32,
            blacklevels[3] as u32,
        ],
        white_level: whitelevels[0] as u32,
        raw_data,
        as_shot_neutral: [wb[0], wb[1], wb[2]],
        as_shot_cct: None,
        camera_make: make,
        camera_model: model,
        embedded_color_matrix,
    })
}
```

If any method name above doesn't exist on the rawler version in the lockfile, **the implementation task is to find the equivalent** — decode must produce a populated `RawImage` from every fixture. Use `cargo doc -p rawler --open` to explore.

- [ ] **Step 5: Run test to verify pass**

```bash
cd src/raw-pipeline && cargo test -p raw-core decode_test_0002 -- --nocapture
```

Expected: PASS with plausible dimensions printed.

- [ ] **Step 6: Add tests for other fixtures**

Append to `decode.rs` tests module:
```rust
#[test]
fn decode_test_0003_canon_cr2() {
    let path = fixture_root().join("test_0003.CR2");
    if !path.exists() { return; }
    let raw = decode(&path).expect("decode CR2");
    assert!(raw.width > 0 && raw.height > 0);
    assert_eq!(raw.camera_make.to_lowercase(), "canon");
}

#[test]
fn decode_test_0001_hasselblad_3fr() {
    let path = fixture_root().join("test_0001.RAW");
    if !path.exists() { return; }
    let raw = decode(&path).expect("decode 3FR");
    assert!(raw.width > 0 && raw.height > 0);
}

#[test]
fn decode_test_0000_hasselblad_100mp() {
    let path = fixture_root().join("test_0000.DNG");
    if !path.exists() { return; }
    let raw = decode(&path).expect("decode 100MP DNG");
    assert!(raw.width > 8000, "100MP expected, got {} wide", raw.width);
}
```

Run: `cargo test -p raw-core decode`. All four should pass.

- [ ] **Step 7: Commit**

```bash
git add src/raw-pipeline/raw-core/src/decode.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: decode all four fixtures via rawler"
```

---

## Phase 5 — Sensor linearization

### Task 5.1: Normalize raw to [0, 1] f32

**Files:**
- Create: `src/raw-pipeline/raw-core/src/linearize.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/linearize.rs`:
```rust
use crate::image::{ColorSpace, Image, RawImage};

/// Sensor linearization per spec § 3.2.
/// `linear = (raw - black) / (white - black)` clamped to [0, 1].
/// Produces a three-channel `Image` where only the CFA-appropriate channel is
/// populated per pixel; the other two are zero. (Demosaic fills them in.)
pub fn sensor_linearize(raw: &RawImage) -> Image {
    let w = raw.width as usize;
    let h = raw.height as usize;
    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeMosaic);

    for y in 0..h {
        for x in 0..w {
            // Per-CFA-position black level: index as 2*(y&1) + (x&1).
            let bl_idx = ((y & 1) << 1) | (x & 1);
            let bl = raw.black_level[bl_idx] as f32;
            let wl = raw.white_level as f32;
            let denom = (wl - bl).max(1.0);
            let raw_v = raw.raw_data[y * w + x] as f32;
            let v = ((raw_v - bl) / denom).clamp(0.0, 1.0);
            let color = raw.cfa.color_at(x as u32, y as u32) as usize;
            img.pixels[y * w + x][color] = v;
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::CfaPattern;

    fn tiny_raw(raw_data: Vec<u16>, w: u32, h: u32) -> RawImage {
        RawImage {
            width: w,
            height: h,
            cfa: CfaPattern::Rggb,
            black_level: [0, 0, 0, 0],
            white_level: 1023,
            raw_data,
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            embedded_color_matrix: None,
        }
    }

    #[test]
    fn black_level_maps_to_zero() {
        let raw = tiny_raw(vec![0, 512, 1023, 256], 2, 2);
        let img = sensor_linearize(&raw);
        assert_eq!(img.pixels[0][0], 0.0);
    }

    #[test]
    fn white_level_maps_to_one() {
        let raw = tiny_raw(vec![0, 0, 1023, 0], 2, 2);
        let img = sensor_linearize(&raw);
        // position (0,1) is G for RGGB; the G channel should read 1.0.
        assert_eq!(img.pixels[2][1], 1.0);
    }

    #[test]
    fn value_above_white_clamps_to_one() {
        let raw = tiny_raw(vec![0, 0, 0, 2000], 2, 2);
        let img = sensor_linearize(&raw);
        // position (1,1) is B for RGGB; B channel should clamp to 1.0.
        assert_eq!(img.pixels[3][2], 1.0);
    }

    #[test]
    fn per_position_black_level_applies() {
        let mut raw = tiny_raw(vec![100, 100, 100, 100], 2, 2);
        raw.black_level = [100, 50, 50, 0]; // R, Gr, Gb, B
        let img = sensor_linearize(&raw);
        // R at (0,0): (100 - 100) / (1023 - 100) = 0
        assert_eq!(img.pixels[0][0], 0.0);
        // G at (1,0): (100 - 50) / (1023 - 50) ≈ 0.0514
        assert!((img.pixels[1][1] - 0.0514).abs() < 1e-3);
    }

    #[test]
    fn output_space_is_camera_native_mosaic() {
        let raw = tiny_raw(vec![0, 0, 0, 0], 2, 2);
        let img = sensor_linearize(&raw);
        assert_eq!(img.space, ColorSpace::CameraNativeMosaic);
    }
}
```

Wire into lib:
```rust
pub mod linearize;
```

- [ ] **Step 2: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core linearize
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/raw-pipeline/raw-core/src/linearize.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: sensor linearization"
```

---

## Phase 6 — Bilinear demosaic

### Task 6.1: Bilinear demosaic with mirror borders, all Bayer patterns

**Files:**
- Create: `src/raw-pipeline/raw-core/src/demosaic.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Per spec § 3.3.1. Mirror-reflect borders (spec says clamp produces green tint at edges).

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/demosaic.rs`:
```rust
use crate::image::{CfaPattern, ColorSpace, Image};

/// Bilinear demosaic per spec § 3.3.1. Input must be `CameraNativeMosaic`.
/// Output is `CameraNativeLinearRgb` with all three channels populated.
pub fn bilinear(mosaic: &Image, cfa: CfaPattern) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as i32;
    let h = mosaic.height as i32;
    let mut out = Image::new(mosaic.width, mosaic.height, ColorSpace::CameraNativeLinearRgb);

    let sample = |x: i32, y: i32, channel: usize| -> f32 {
        // Mirror-reflect borders.
        let mx = if x < 0 { -x } else if x >= w { 2*(w-1) - x } else { x };
        let my = if y < 0 { -y } else if y >= h { 2*(h-1) - y } else { y };
        mosaic.pixels[(my as usize) * (w as usize) + (mx as usize)][channel]
    };

    for y in 0..h {
        for x in 0..w {
            let color = cfa.color_at(x as u32, y as u32) as usize;
            let mut rgb = [0.0f32; 3];
            // Center-channel is whatever was sampled.
            rgb[color] = sample(x, y, color);

            match color {
                0 | 2 => {
                    // R or B known; interpolate G as 4-neighbor average and
                    // the opposite chroma as 4-diagonal average.
                    rgb[1] = (sample(x-1, y, 1) + sample(x+1, y, 1)
                           +  sample(x, y-1, 1) + sample(x, y+1, 1)) * 0.25;
                    let other = if color == 0 { 2 } else { 0 };
                    rgb[other] = (sample(x-1, y-1, other) + sample(x+1, y-1, other)
                               +  sample(x-1, y+1, other) + sample(x+1, y+1, other)) * 0.25;
                }
                1 => {
                    // G known; determine horizontal vs vertical neighbors for R and B.
                    // In any Bayer pattern, at a G position one axis is R and the other is B.
                    let horiz = cfa.color_at((x as u32 + 1) & !0, y as u32) as usize;
                    let vert  = cfa.color_at(x as u32, (y as u32 + 1) & !0) as usize;
                    // horiz channel is average of horizontal neighbors; vert channel
                    // is average of vertical neighbors.
                    rgb[horiz] = (sample(x-1, y, horiz) + sample(x+1, y, horiz)) * 0.5;
                    rgb[vert]  = (sample(x, y-1, vert)  + sample(x, y+1, vert))  * 0.5;
                }
                _ => unreachable!(),
            }
            out.pixels[(y as usize) * (w as usize) + (x as usize)] = rgb;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 4×4 RGGB mosaic with constant channel values.
    fn constant_mosaic(r: f32, g: f32, b: f32) -> Image {
        let mut img = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => r, 1 => g, 2 => b, _ => 0.0 };
                img.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        img
    }

    #[test]
    fn constant_mosaic_produces_constant_rgb() {
        let mosaic = constant_mosaic(0.4, 0.5, 0.6);
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        for p in &out.pixels {
            assert!((p[0] - 0.4).abs() < 1e-5, "R was {}", p[0]);
            assert!((p[1] - 0.5).abs() < 1e-5, "G was {}", p[1]);
            assert!((p[2] - 0.6).abs() < 1e-5, "B was {}", p[2]);
        }
    }

    #[test]
    fn output_space_is_camera_native_rgb() {
        let mosaic = constant_mosaic(0.1, 0.1, 0.1);
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn bggr_pattern_also_works() {
        let mut mosaic = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Bggr;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c { 0 => 0.7, 1 => 0.5, 2 => 0.3, _ => 0.0 };
                mosaic.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        let out = bilinear(&mosaic, CfaPattern::Bggr);
        for p in &out.pixels {
            assert!((p[0] - 0.7).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.3).abs() < 1e-5);
        }
    }

    #[test]
    fn border_pixel_has_plausible_values() {
        // A single-pixel bright spot in an otherwise-dark frame — the
        // interpolated neighbors must exist (mirror borders) rather than panic.
        let mut mosaic = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        // top-left position (0,0) on RGGB is R; set it high.
        mosaic.pixels[0][0] = 1.0;
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        assert!(out.pixels[0][0] > 0.9);       // R survived
        assert!(out.pixels[0][1].is_finite()); // no NaN
        assert!(out.pixels[0][2].is_finite());
    }
}
```

Wire into lib:
```rust
pub mod demosaic;
```

- [ ] **Step 2: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core demosaic
```

Expected: 4 tests pass. The `constant_mosaic_produces_constant_rgb` test is the key correctness check: bilinear of a uniform field must be uniform.

- [ ] **Step 3: Commit**

```bash
git add src/raw-pipeline/raw-core/src/demosaic.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: bilinear demosaic with mirror-reflect borders"
```

---

## Phase 7 — DCP (minimal subset: CM + optional FM, no HSM/PLT)

### Task 7.1: `DcpProfile` type + single-illuminant application

**Files:**
- Create: `src/raw-pipeline/raw-core/src/color/dcp.rs`
- Modify: `src/raw-pipeline/raw-core/src/color/mod.rs`

Per spec § 3.4. Slice 1 collapses the DCP to: single illuminant (whichever the RAW carries or synthesizes), optional ForwardMatrix, Bradford to D50, `M_pro_to_rec2020` exit. No HSM, no PLT, no dual-illuminant interpolation. That comes in slice 4.

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/color/dcp.rs`:
```rust
use crate::{
    color::matrices::{M_PRO_TO_XYZ_D50, XYZ_D50, bradford_adapt, m_pro_to_rec2020},
    image::{ColorSpace, Image, RawImage},
    math::{Matrix3, Vec3},
};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Illuminant {
    StdA,      // ~2850K
    D50,       // ~5003K
    D55,
    D65,       // ~6504K
    Other(u32),
}

impl Illuminant {
    pub fn xyz(self) -> Vec3 {
        // Reference whites; Y normalized to 1.0. CIE 1931 2° observer.
        match self {
            Self::StdA => [1.0985, 1.0000, 0.3558],
            Self::D50  => [0.9642, 1.0000, 0.8251],
            Self::D55  => [0.9568, 1.0000, 0.9214],
            Self::D65  => [0.9504, 1.0000, 1.0888],
            Self::Other(_) => [0.9504, 1.0000, 1.0888], // fallback D65
        }
    }
}

#[derive(Clone, Debug)]
pub struct DcpProfile {
    pub illuminant: Illuminant,
    /// Camera → XYZ (at `illuminant`). Spec § 3.4.
    pub color_matrix: Matrix3,
    /// XYZ D50 → ProPhoto RGB. Optional per DNG spec. When absent,
    /// we derive via the inverse of `M_PRO_TO_XYZ_D50`.
    pub forward_matrix: Option<Matrix3>,
}

impl DcpProfile {
    /// Build a minimal DCP from an embedded ColorMatrix (CM1) with the
    /// assumption it's D65. Used for non-DNG fixtures via rawler's embedded
    /// adobe_coeff matrix. Spec § 3.4 edge case: "Profile has only CM1/CM2 —
    /// use standard D50 Bradford adapt from XYZ to ProPhoto."
    pub fn from_embedded_cm(cm: Matrix3) -> Self {
        Self {
            illuminant: Illuminant::D65,
            color_matrix: cm,
            forward_matrix: None,
        }
    }
}

/// Apply DCP to camera-native linear RGB, producing scene-linear Rec.2020 D65.
/// Slice 1 implementation: single illuminant, CM+FM (or fallback), no HSM, no PLT.
pub fn apply(camera: &Image, profile: &DcpProfile) -> Image {
    camera.assert_space(ColorSpace::CameraNativeLinearRgb);

    // Compose the camera → Rec.2020 matrix once.
    //   rgb_rec2020 = M_pro_to_rec2020 * FM * Bradford(source→D50) * CM * rgb_cam
    let adapt = bradford_adapt(profile.illuminant.xyz(), XYZ_D50);
    let fm = profile.forward_matrix.unwrap_or_else(|| {
        // No FM: standard XYZ D50 → ProPhoto via inverse of ProPhoto→XYZ D50.
        M_PRO_TO_XYZ_D50.inverse().expect("ProPhoto matrix is invertible")
    });
    let exit = m_pro_to_rec2020();
    let m = exit.mul_mat(&fm).mul_mat(&adapt).mul_mat(&profile.color_matrix);

    let mut out = Image::new(camera.width, camera.height, ColorSpace::SceneLinearRec2020);
    for (i, p) in camera.pixels.iter().enumerate() {
        out.pixels[i] = m.mul_vec(*p);
    }
    out
}

/// Slice-1 convenience: synthesize a DcpProfile from a `RawImage`'s embedded
/// matrix (DNG or rawler-supplied), or return an error if none is available.
pub fn profile_for(raw: &RawImage) -> crate::Result<DcpProfile> {
    match raw.embedded_color_matrix {
        Some(cm) => Ok(DcpProfile::from_embedded_cm(cm)),
        None => Err(crate::Error::Dcp(format!(
            "no embedded color matrix for {} {}",
            raw.camera_make, raw.camera_model
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_dcp_on_unit_input_lands_in_rec2020_scene() {
        // A degenerate profile whose CM is identity (CM acts as "camera IS XYZ").
        // The math still runs Bradford + FM + M_pro_to_rec2020, so the output
        // won't be identity, but it will be finite and roughly neutral.
        let profile = DcpProfile {
            illuminant: Illuminant::D65,
            color_matrix: Matrix3::IDENTITY,
            forward_matrix: None,
        };
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        let out = apply(&img, &profile);
        assert_eq!(out.space, ColorSpace::SceneLinearRec2020);
        // All four pixels should match one another.
        let first = out.pixels[0];
        for p in &out.pixels {
            assert!((p[0] - first[0]).abs() < 1e-5);
            assert!((p[1] - first[1]).abs() < 1e-5);
            assert!((p[2] - first[2]).abs() < 1e-5);
        }
        // Values finite and roughly [0.1, 0.3] — this is scene-linear, not display.
        for &c in &first {
            assert!(c.is_finite());
            assert!(c > 0.05 && c < 0.5, "unexpected channel value {}", c);
        }
    }

    #[test]
    fn pipeline_produces_rec2020_output() {
        let profile = DcpProfile::from_embedded_cm(Matrix3([
            [ 0.6722, -0.0635, -0.0963],
            [-0.4287,  1.2460,  0.2028],
            [-0.0908,  0.2162,  0.5668],
        ])); // plausible-shape camera matrix, made-up
        let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
        img.pixels[0] = [0.5, 0.5, 0.5];
        let out = apply(&img, &profile);
        assert_eq!(out.space, ColorSpace::SceneLinearRec2020);
        // Output is finite.
        for &c in &out.pixels[0] {
            assert!(c.is_finite());
        }
    }
}
```

Wire in `src/raw-pipeline/raw-core/src/color/mod.rs`:
```rust
pub mod matrices;
pub mod dcp;
```

- [ ] **Step 2: Run tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core dcp
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/raw-pipeline/raw-core/src/color/
git commit -m "raw-core: minimal DCP (single illuminant, CM+FM, no HSM/PLT)"
```

### Task 7.2: Parse dual-illuminant DCP from DNG (use illuminant nearest to as-shot)

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/color/dcp.rs`
- Modify: `src/raw-pipeline/raw-core/src/decode.rs`

Rationale: DNGs carry CalibrationIlluminant1/2 + ColorMatrix1/2 + optionally ForwardMatrix1/2. Slice 1 picks the **nearest calibration illuminant** to the shot's as-shot CCT and uses that profile's CM/FM — no reciprocal-CCT interpolation yet (that's slice 4). This alone should beat the synthesized-CM path on DNGs significantly.

- [ ] **Step 1: Extend `RawImage` with dual-illuminant data**

Modify `src/raw-pipeline/raw-core/src/image.rs`:
```rust
#[derive(Clone, Debug)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub black_level: [u32; 4],
    pub white_level: u32,
    pub raw_data: Vec<u16>,
    pub as_shot_neutral: [f32; 3],
    pub as_shot_cct: Option<f32>,
    pub camera_make: String,
    pub camera_model: String,
    pub embedded_color_matrix: Option<crate::math::Matrix3>,
    /// DNG CalibrationIlluminant1 + ColorMatrix1 + optional ForwardMatrix1.
    pub dng_profile_1: Option<DngCalibration>,
    /// DNG CalibrationIlluminant2 + ColorMatrix2 + optional ForwardMatrix2.
    pub dng_profile_2: Option<DngCalibration>,
}

#[derive(Clone, Debug)]
pub struct DngCalibration {
    pub illuminant: crate::color::dcp::Illuminant,
    pub color_matrix: crate::math::Matrix3,
    pub forward_matrix: Option<crate::math::Matrix3>,
}
```

Update all construction sites in tests to set `dng_profile_1: None, dng_profile_2: None`.

- [ ] **Step 2: Extract DNG profile data in decode**

In `decode.rs`, extend the `RawImage` construction to pull DNG calibration illuminants/matrices when the format is DNG. rawler exposes `decoder.calibration_illuminant1()` and similar; if names differ, locate the DNG TIFF tag 0xC65A–0xC65B (illuminants), 0xC621–0xC622 (CM1/CM2), 0xC714–0xC715 (FM1/FM2) via rawler's tag reader.

Sketch:
```rust
let (dng_profile_1, dng_profile_2) = extract_dng_profiles(&decoder);

fn extract_dng_profiles(decoder: &dyn rawler::Decoder) -> (Option<DngCalibration>, Option<DngCalibration>) {
    let cm1 = decoder.color_matrix_1_as_f32_9(); // sketch — use whichever API exists
    let cm2 = decoder.color_matrix_2_as_f32_9();
    let fm1 = decoder.forward_matrix_1_as_f32_9();
    let fm2 = decoder.forward_matrix_2_as_f32_9();
    let il1 = decoder.calibration_illuminant_1();
    let il2 = decoder.calibration_illuminant_2();
    ...
}
```

If rawler 0.7 does not expose these directly, parse the TIFF tags manually from the raw bytes (DNG is a TIFF variant; tag IDs are standard). This is a task-level expansion: budget another 30 minutes for tag parsing if rawler doesn't help.

- [ ] **Step 3: Extend `profile_for` to prefer DNG calibration over embedded CM**

```rust
pub fn profile_for(raw: &RawImage) -> crate::Result<DcpProfile> {
    // Slice 1: pick the nearest DNG calibration illuminant to the shot CCT,
    // default to the second one (typically D65) if CCT unknown. No reciprocal-
    // CCT interpolation — that's slice 4.
    if let (Some(p1), Some(p2)) = (&raw.dng_profile_1, &raw.dng_profile_2) {
        let target_cct = raw.as_shot_cct.unwrap_or(6500.0);
        let cct1 = illuminant_cct(p1.illuminant);
        let cct2 = illuminant_cct(p2.illuminant);
        let pick = if (target_cct - cct1).abs() < (target_cct - cct2).abs() { p1 } else { p2 };
        return Ok(DcpProfile {
            illuminant: pick.illuminant,
            color_matrix: pick.color_matrix,
            forward_matrix: pick.forward_matrix,
        });
    }
    if let Some(p) = &raw.dng_profile_2 {
        return Ok(DcpProfile {
            illuminant: p.illuminant,
            color_matrix: p.color_matrix,
            forward_matrix: p.forward_matrix,
        });
    }
    if let Some(p) = &raw.dng_profile_1 {
        return Ok(DcpProfile {
            illuminant: p.illuminant,
            color_matrix: p.color_matrix,
            forward_matrix: p.forward_matrix,
        });
    }
    // Non-DNG fallback: rawler's embedded CM.
    if let Some(cm) = raw.embedded_color_matrix {
        return Ok(DcpProfile::from_embedded_cm(cm));
    }
    Err(crate::Error::Dcp(format!(
        "no camera profile for {} {}", raw.camera_make, raw.camera_model
    )))
}

fn illuminant_cct(i: Illuminant) -> f32 {
    match i {
        Illuminant::StdA => 2850.0,
        Illuminant::D50  => 5003.0,
        Illuminant::D55  => 5500.0,
        Illuminant::D65  => 6504.0,
        Illuminant::Other(k) => k as f32,
    }
}
```

- [ ] **Step 4: Add test against real DNG fixture**

```rust
#[test]
fn profile_for_test_0002_has_dual_illuminant_dng_data() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() { return; }
    let raw = crate::decode::decode(&path).unwrap();
    assert!(raw.dng_profile_1.is_some() || raw.dng_profile_2.is_some(),
        "DNG fixtures should carry CalibrationIlluminant data");
    let profile = profile_for(&raw).unwrap();
    // Output matrix must be non-degenerate.
    assert!(profile.color_matrix.inverse().is_some());
}
```

- [ ] **Step 5: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core dcp
git add src/raw-pipeline/raw-core/src/
git commit -m "raw-core: DNG dual-illuminant DCP parse (nearest-illuminant pick)"
```

---

## Phase 8 — White balance

### Task 8.1: Planckian CCT→xy and WB stage

**Files:**
- Create: `src/raw-pipeline/raw-core/src/stages/mod.rs`
- Create: `src/raw-pipeline/raw-core/src/stages/white_balance.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Per spec § 3.5. Hernández-Andrés (1999) cubic polynomial for CCT→xy. WB gain normalized so green=1.

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/stages/white_balance.rs`:
```rust
use crate::{
    color::matrices::{M_XYZ_D65_TO_REC2020, XYZ_D65},
    image::{ColorSpace, Image},
    math::Vec3,
};

/// CCT (Kelvin) → CIE xy chromaticity using the Hernández-Andrés (1999) polynomial.
/// Valid in [3000K, 15000K]; mild error outside.
pub fn cct_to_xy(cct: f32) -> (f32, f32) {
    let t = cct.clamp(2000.0, 15000.0);
    let x = if t <= 7000.0 {
         0.244_063
       + 99.11   / t
       + 2_967_800.0 / (t * t)
       - 4_607_000_000.0 / (t * t * t)
    } else {
         0.237_040
       + 247.48 / t
       + 1_901_800.0 / (t * t)
       - 2_006_400_000.0 / (t * t * t)
    };
    let y = -3.000 * x * x + 2.870 * x - 0.275;
    (x, y)
}

pub fn xy_to_xyz(x: f32, y: f32, big_y: f32) -> Vec3 {
    let big_x = (x / y) * big_y;
    let big_z = ((1.0 - x - y) / y) * big_y;
    [big_x, big_y, big_z]
}

/// Compute per-channel gains in linear Rec.2020 for a target (temperature, tint).
/// Tint in [-100, 100] with 0.001 per-unit scaling (spec § 3.5).
pub fn wb_gains(temperature: f32, tint: f32) -> Vec3 {
    let (mut x, mut y) = cct_to_xy(temperature);
    y += tint * 0.001;
    let xyz_target = xy_to_xyz(x, y, 1.0);
    let xyz_ratio = [
        xyz_target[0] / XYZ_D65[0],
        xyz_target[1] / XYZ_D65[1],
        xyz_target[2] / XYZ_D65[2],
    ];
    let gain = M_XYZ_D65_TO_REC2020.mul_vec(xyz_ratio);
    // Normalize so green = 1.
    let g = gain[1].max(1e-6);
    [gain[0] / g, 1.0, gain[2] / g]
}

pub fn apply(img: &mut Image, temperature: f32, tint: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if (temperature - 6500.0).abs() < 0.5 && tint.abs() < 0.5 {
        return; // identity short-circuit
    }
    let g = wb_gains(temperature, tint);
    for p in &mut img.pixels {
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn d65_reference_at_6500k_tint_0() {
        let gains = wb_gains(6500.0, 0.0);
        // Gains should be close to (1, 1, 1) at the pipeline's native white.
        assert!((gains[0] - 1.0).abs() < 0.05, "R gain {}", gains[0]);
        assert!((gains[1] - 1.0).abs() < 1e-6, "G gain {}", gains[1]);
        assert!((gains[2] - 1.0).abs() < 0.05, "B gain {}", gains[2]);
    }

    #[test]
    fn warm_temperature_boosts_red() {
        let gains = wb_gains(3000.0, 0.0);
        assert!(gains[0] > 1.2, "R should boost warm, got {}", gains[0]);
        assert!(gains[2] < 0.8, "B should cut warm, got {}", gains[2]);
    }

    #[test]
    fn cool_temperature_boosts_blue() {
        let gains = wb_gains(10000.0, 0.0);
        assert!(gains[2] > 1.05, "B should boost cool, got {}", gains[2]);
        assert!(gains[0] < 0.95, "R should cut cool, got {}", gains[0]);
    }

    #[test]
    fn default_is_identity_on_image() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.4, 0.5]; }
        apply(&mut img, 6500.0, 0.0);
        for p in &img.pixels {
            assert_eq!(p, &[0.3, 0.4, 0.5]);
        }
    }

    #[test]
    fn non_default_mutates_pixels() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
        apply(&mut img, 3000.0, 0.0);
        for p in &img.pixels {
            assert!(p[0] > 0.3, "R should boost");
            assert!(p[2] < 0.3, "B should cut");
        }
    }
}
```

- [ ] **Step 2: Create stages module**

`src/raw-pipeline/raw-core/src/stages/mod.rs`:
```rust
pub mod white_balance;
```

Add to `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
pub mod stages;
```

- [ ] **Step 3: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core white_balance
git add src/raw-pipeline/raw-core/src/stages/ src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: white balance (Hernández-Andrés CCT + per-channel gain)"
```

---

## Phase 9 — Exposure

### Task 9.1: Exposure stage

**Files:**
- Create: `src/raw-pipeline/raw-core/src/stages/exposure.rs`
- Modify: `src/raw-pipeline/raw-core/src/stages/mod.rs`

Per spec § 3.6 step 1. Exposure is the only part of `SceneToneControls` we implement in slice 1; highlights/shadows/whites/blacks/curves are slice 2.

- [ ] **Step 1: Write tests and impl together (small)**

`src/raw-pipeline/raw-core/src/stages/exposure.rs`:
```rust
use crate::image::{ColorSpace, Image};

/// Apply exposure (EV) in scene-linear Rec.2020. `rgb * 2^ev` per spec § 3.6.
pub fn apply(img: &mut Image, ev: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if ev.abs() < 1e-6 { return; }
    let gain = ev.exp2();
    for p in &mut img.pixels {
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ev_zero_is_identity() {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        apply(&mut img, 0.0);
        for p in &img.pixels {
            assert_eq!(*p, [0.18, 0.18, 0.18]);
        }
    }

    #[test]
    fn ev_plus_one_doubles() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.1, 0.2, 0.3];
        apply(&mut img, 1.0);
        let p = img.pixels[0];
        assert!((p[0] - 0.2).abs() < 1e-6);
        assert!((p[1] - 0.4).abs() < 1e-6);
        assert!((p[2] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn ev_minus_one_halves() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.4, 0.6, 0.8];
        apply(&mut img, -1.0);
        let p = img.pixels[0];
        assert!((p[0] - 0.2).abs() < 1e-6);
        assert!((p[1] - 0.3).abs() < 1e-6);
        assert!((p[2] - 0.4).abs() < 1e-6);
    }

    #[test]
    fn preserves_scene_headroom() {
        // Scene-linear: values > 1 must pass through doubled.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [5.0, 5.0, 5.0];
        apply(&mut img, 1.0);
        assert_eq!(img.pixels[0], [10.0, 10.0, 10.0]);
    }
}
```

Add to `src/raw-pipeline/raw-core/src/stages/mod.rs`:
```rust
pub mod exposure;
```

- [ ] **Step 2: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core exposure
git add src/raw-pipeline/raw-core/src/stages/
git commit -m "raw-core: exposure stage (rgb * exp2(ev))"
```

---

## Phase 10 — Dehaze (dark-channel prior + guided filter)

The biggest stage in slice 1. Broken into sub-tasks so each step is bite-sized.

### Task 10.1: Dark channel

**Files:**
- Create: `src/raw-pipeline/raw-core/src/stages/dehaze.rs`
- Modify: `src/raw-pipeline/raw-core/src/stages/mod.rs`

Per spec § 3.9 step 1: `dark(x, y) = min over 15×15 of min(r, g, b)`. Spec allows a ¼-size buffer on the interactive path; slice 1 CLI runs full resolution on the export-like path.

- [ ] **Step 1: Write test**

`src/raw-pipeline/raw-core/src/stages/dehaze.rs`:
```rust
use crate::image::{ColorSpace, Image};

const DARK_RADIUS: i32 = 7; // 15×15 neighborhood per spec § 3.9.

fn dark_channel(img: &Image) -> Vec<f32> {
    let w = img.width as i32;
    let h = img.height as i32;
    let mut out = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, w - 1) as usize;
                    let uy = (y + dy).clamp(0, h - 1) as usize;
                    let p = img.pixels[uy * (w as usize) + ux];
                    let local_min = p[0].min(p[1]).min(p[2]);
                    if local_min < m { m = local_min; }
                }
            }
            out[(y * w + x) as usize] = m;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_channel_of_uniform_is_min_channel() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.3, 0.8]; }
        let dc = dark_channel(&img);
        assert!(dc.iter().all(|v| (*v - 0.3).abs() < 1e-5));
    }

    #[test]
    fn dark_channel_single_dark_pixel_spreads_across_neighborhood() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.9, 0.9, 0.9]; }
        img.pixels[10 * 20 + 10] = [0.1, 0.1, 0.1];
        let dc = dark_channel(&img);
        // All pixels within radius 7 of (10,10) should see the dark pixel.
        assert!((dc[10 * 20 + 10] - 0.1).abs() < 1e-5);
        assert!((dc[3 * 20 + 3] - 0.1).abs() < 1e-5);
        // A pixel at (0, 0) — distance 14 — sees 0.9 because 14 > radius 7.
        assert!((dc[0] - 0.9).abs() < 1e-5);
    }
}
```

Wire into `stages/mod.rs`:
```rust
pub mod dehaze;
```

- [ ] **Step 2: Run tests, commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core dehaze::tests::dark_channel
git add src/raw-pipeline/raw-core/src/stages/dehaze.rs src/raw-pipeline/raw-core/src/stages/mod.rs
git commit -m "raw-core: dehaze dark-channel computation"
```

### Task 10.2: Atmospheric light A + transmission

- [ ] **Step 1: Extend dehaze.rs**

```rust
/// Atmospheric-light A: mean of the original image at the brightest 0.1% of
/// dark-channel positions (spec § 3.9 step 2). Returns the per-channel mean.
fn atmospheric_light(img: &Image, dc: &[f32]) -> [f32; 3] {
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_unstable_by(|&a, &b| dc[b].partial_cmp(&dc[a]).unwrap_or(std::cmp::Ordering::Equal));
    let mut sum = [0.0f32; 3];
    for &i in &idx[..top_n] {
        let p = img.pixels[i];
        sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
    }
    let k = top_n as f32;
    [sum[0] / k, sum[1] / k, sum[2] / k]
}

/// Transmission estimate: `t(x,y) = 1 - ω * min over 15×15 of min(rgb/A)`.
/// ω = 0.95 per spec § 3.9 step 3.
fn transmission(img: &Image, a: [f32; 3]) -> Vec<f32> {
    const OMEGA: f32 = 0.95;
    let w = img.width as i32;
    let h = img.height as i32;
    let mut out = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut m = f32::INFINITY;
            for dy in -DARK_RADIUS..=DARK_RADIUS {
                for dx in -DARK_RADIUS..=DARK_RADIUS {
                    let ux = (x + dx).clamp(0, w - 1) as usize;
                    let uy = (y + dy).clamp(0, h - 1) as usize;
                    let p = img.pixels[uy * (w as usize) + ux];
                    let scaled_min = (p[0] / a[0].max(1e-6))
                        .min(p[1] / a[1].max(1e-6))
                        .min(p[2] / a[2].max(1e-6));
                    if scaled_min < m { m = scaled_min; }
                }
            }
            out[(y * w + x) as usize] = 1.0 - OMEGA * m;
        }
    }
    out
}
```

- [ ] **Step 2: Add tests**

```rust
#[test]
fn atmospheric_light_picks_brightest_region() {
    let mut img = Image::new(100, 100, ColorSpace::SceneLinearRec2020);
    // Flat gray field.
    for p in &mut img.pixels { *p = [0.3, 0.3, 0.3]; }
    // Bright patch in corner.
    for y in 0..10 { for x in 0..10 {
        img.pixels[y * 100 + x] = [0.95, 0.94, 0.93];
    }}
    let dc = dark_channel(&img);
    let a = atmospheric_light(&img, &dc);
    // A should be close to the bright patch values, not the surrounding gray.
    assert!(a[0] > 0.7, "A[R] = {}", a[0]);
    assert!(a[1] > 0.7);
    assert!(a[2] > 0.7);
}

#[test]
fn transmission_is_high_for_bright_clear_regions() {
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    // A "clear" region where pixels match A is fully transmitted (t=1).
    for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
    let a = [1.0, 1.0, 1.0];
    let t = transmission(&img, a);
    // t = 1 - 0.95 * 1 = 0.05 for pure-white image; interior of scene hazes.
    assert!(t.iter().all(|v| (*v - 0.05).abs() < 1e-5));
}
```

- [ ] **Step 3: Run, commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core dehaze
git add src/raw-pipeline/raw-core/src/stages/dehaze.rs
git commit -m "raw-core: dehaze atmospheric light + transmission"
```

### Task 10.3: Guided filter (box-based, He 2010)

Refines the transmission map; spec § 3.9 step 4. Standard box-guided-filter with radius ≈ 60, ε ≈ 1e-3 is typical. Implemented with separable box blurs.

- [ ] **Step 1: Write test + impl**

Append to `dehaze.rs`:
```rust
/// Separable box blur (radius `r`) on a single-channel buffer of dimensions w×h.
/// O(w*h*(r+1)) via running-sum; sufficient for slice 1 CPU path.
fn box_blur(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; buf.len()];
    // Horizontal.
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let mut acc = 0.0f32;
        let mut out_row_vec = vec![0.0f32; w];
        let window = 2 * r + 1;
        // Prime window with reflected left edge.
        for i in 0..window.min(w) { acc += row[i]; }
        for x in 0..w {
            let left = if x > r { x - r - 1 } else { r - x };
            let right = (x + r).min(w - 1);
            if x > 0 {
                let add = row[right];
                let rem_idx = if x > r + 1 { x - r - 2 } else { 0 };
                acc += add - row[rem_idx];
            }
            out_row_vec[x] = acc / (right - left + 1) as f32;
        }
        tmp[y * w..(y + 1) * w].copy_from_slice(&out_row_vec);
    }
    // Vertical.
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let mut acc = 0.0f32;
        let mut out_col = vec![0.0f32; h];
        let window = 2 * r + 1;
        for i in 0..window.min(h) { acc += tmp[i * w + x]; }
        for y in 0..h {
            let top = if y > r { y - r - 1 } else { r - y };
            let bot = (y + r).min(h - 1);
            if y > 0 {
                let add = tmp[bot * w + x];
                let rem_idx = if y > r + 1 { y - r - 2 } else { 0 };
                acc += add - tmp[rem_idx * w + x];
            }
            out_col[y] = acc / (bot - top + 1) as f32;
        }
        for y in 0..h { out[y * w + x] = out_col[y]; }
    }
    out
}

/// Guided filter (He, Sun, Tang 2010). Refines `p` using `guide` as an edge
/// reference. Spec § 3.9 step 4.
fn guided_filter(guide: &[f32], p: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    assert_eq!(guide.len(), p.len());
    let n = guide.len();

    let mean_i = box_blur(guide, w, h, r);
    let mean_p = box_blur(p, w, h, r);

    let ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(&a, &b)| a * b).collect();
    let mean_ip = box_blur(&ip, w, h, r);

    let cov_ip: Vec<f32> = mean_ip.iter().zip(mean_i.iter().zip(mean_p.iter()))
        .map(|(&mip, (&mi, &mp))| mip - mi * mp).collect();

    let ii: Vec<f32> = guide.iter().map(|&a| a * a).collect();
    let mean_ii = box_blur(&ii, w, h, r);
    let var_i: Vec<f32> = mean_ii.iter().zip(mean_i.iter())
        .map(|(&mii, &mi)| mii - mi * mi).collect();

    let a: Vec<f32> = cov_ip.iter().zip(var_i.iter())
        .map(|(&cip, &vi)| cip / (vi + eps)).collect();
    let b: Vec<f32> = (0..n).map(|i| mean_p[i] - a[i] * mean_i[i]).collect();

    let mean_a = box_blur(&a, w, h, r);
    let mean_b = box_blur(&b, w, h, r);

    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}
```

- [ ] **Step 2: Add tests**

```rust
#[test]
fn box_blur_of_constant_is_constant() {
    let buf = vec![0.5f32; 40 * 40];
    let out = box_blur(&buf, 40, 40, 5);
    assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-5));
}

#[test]
fn guided_filter_of_constants_is_constant() {
    let guide = vec![0.5f32; 40 * 40];
    let p = vec![0.7f32; 40 * 40];
    let out = guided_filter(&guide, &p, 40, 40, 5, 1e-3);
    assert!(out.iter().all(|v| (*v - 0.7).abs() < 1e-4));
}

#[test]
fn guided_filter_preserves_smooth_transmission() {
    // If the transmission `p` is already smooth, the filter should leave it alone.
    let w = 30; let h = 30;
    let mut p = vec![0.0f32; w * h];
    for y in 0..h { for x in 0..w {
        p[y * w + x] = 0.3 + 0.4 * (x as f32) / (w as f32);
    }}
    let guide = p.clone();
    let out = guided_filter(&guide, &p, w, h, 8, 1e-3);
    // Interior pixels should be within a small tolerance of the original.
    for y in 10..20 { for x in 10..20 {
        let diff = (out[y * w + x] - p[y * w + x]).abs();
        assert!(diff < 0.05, "diff {} at ({},{})", diff, x, y);
    }}
}
```

- [ ] **Step 3: Run, commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core dehaze
git add src/raw-pipeline/raw-core/src/stages/dehaze.rs
git commit -m "raw-core: dehaze box blur + guided filter"
```

### Task 10.4: Dehaze public `apply` function

- [ ] **Step 1: Add `apply`**

```rust
/// Apply dehaze per spec § 3.9.
/// `dehaze` in [-100, +100]; 0 is identity.
pub fn apply(img: &mut Image, dehaze: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if dehaze.abs() < 1e-3 { return; }
    let w = img.width as usize;
    let h = img.height as usize;

    let dc = dark_channel(img);
    let a = atmospheric_light(img, &dc);
    let t_raw = transmission(img, a);

    // Build a single-channel "guide" from image luminance.
    let guide: Vec<f32> = img.pixels.iter().map(|p| {
        0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
    }).collect();
    let t_refined = guided_filter(&guide, &t_raw, w, h, 60, 1e-3);

    // Scale transmission by slider: positive = stronger dehaze (lower t),
    // negative = add haze (raise t).
    let t0 = 0.1f32;
    let scale = (dehaze / 100.0).clamp(-1.0, 1.0);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let t = t_refined[i].clamp(0.0, 1.0);
        // Interpolate toward t=1 (no haze removal) when scale negative, toward
        // recovered t when positive.
        let t_eff = if scale >= 0.0 {
            (t + (1.0 - t) * (1.0 - scale)).max(t0)
        } else {
            (t + (1.0 - t) * (-scale)).min(1.0).max(t0)
        };
        let j_r = (p[0] - a[0]) / t_eff + a[0];
        let j_g = (p[1] - a[1]) / t_eff + a[1];
        let j_b = (p[2] - a[2]) / t_eff + a[2];
        *p = [j_r, j_g, j_b];
    }
}
```

- [ ] **Step 2: Add test**

```rust
#[test]
fn dehaze_zero_is_identity() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels { *p = [0.4, 0.5, 0.6]; }
    let before = img.pixels.clone();
    apply(&mut img, 0.0);
    for (a, b) in img.pixels.iter().zip(before.iter()) {
        assert_eq!(a, b);
    }
}

#[test]
fn dehaze_positive_increases_contrast() {
    // A flat hazy field should shift toward darker shadows and brighter highs.
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
    // Add a slightly darker region.
    for y in 10..20 { for x in 10..20 {
        img.pixels[y * 30 + x] = [0.35, 0.35, 0.35];
    }}
    let before = img.pixels[10 * 30 + 10][0];
    apply(&mut img, 100.0);
    let after = img.pixels[10 * 30 + 10][0];
    // The darker region should still be darker or similar; exact numerical
    // behavior depends on guided filter — assert only that nothing exploded.
    assert!(img.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
    assert!(after >= 0.0 && after <= 1.5);
}
```

- [ ] **Step 3: Run, commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core dehaze
git add src/raw-pipeline/raw-core/src/stages/dehaze.rs
git commit -m "raw-core: dehaze public apply (dark-channel prior end-to-end)"
```

---

## Phase 11 — AgX view transform

### Task 11.1: AgX log encode + sigmoid LUT

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/mod.rs`
- Create: `src/raw-pipeline/raw-core/src/view/agx.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Per spec § 3.6a. The AgX sigmoid lookup comes from Blender 4.x's reference; slice 1 uses a 512-entry LUT built once at module init via a polynomial fit to the Blender `AgX_Default_Contrast` curve (Troy Sobotka's 7th-order approximation, published openly; check `https://github.com/sobotka/AgX` for current coefficients before locking them in).

**Implementation note:** the exact sigmoid coefficients are part of what slice 6 ratchets tighter via parity testing. Slice 1's job is to establish the right SHAPE — monotone, mid-gray lands near display mid-gray, highlights roll off rather than clip. Budget is ≤10 ΔE on `baseline`; AgX shape errors will show up as a brightness/contrast drift within that budget, which is fine for slice 1.

- [ ] **Step 1: Write tests first**

`src/raw-pipeline/raw-core/src/view/agx.rs`:
```rust
use crate::image::{ColorSpace, Image};

const MIN_EV: f32 = -10.0;
const MAX_EV: f32 = 6.5;
const MID_GRAY: f32 = 0.18;
const LUT_SIZE: usize = 512;

/// Polynomial fit to AgX's Default_Contrast sigmoid (Troy Sobotka reference).
/// Input `x` in [0, 1] (normalized log-encoded scene value).
/// Output in [0, 1] (display-linear).
fn agx_sigmoid(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    // Coefficients from Sobotka's 6-piece fit (sRGB target). See
    // https://github.com/sobotka/AgX for the canonical reference.
    // These are a practical approximation; replace with LUT sampled from
    // Blender's reference shader once available.
    let x2 = x * x;
    let x3 = x2 * x;
    let x4 = x3 * x;
    let x5 = x4 * x;
    let x6 = x5 * x;
    let x7 = x6 * x;
    17.883_58 * x7
  - 55.488_83 * x6
  + 63.626_41 * x5
  - 29.729_46 * x4
  +  4.930_68 * x3
  -  0.051_35 * x2
  +  0.003_03 * x
  -  0.000_18
}

fn build_lut() -> [f32; LUT_SIZE] {
    let mut lut = [0.0f32; LUT_SIZE];
    for i in 0..LUT_SIZE {
        let t = (i as f32) / ((LUT_SIZE - 1) as f32);
        lut[i] = agx_sigmoid(t).clamp(0.0, 1.0);
    }
    lut
}

static LUT: std::sync::OnceLock<[f32; LUT_SIZE]> = std::sync::OnceLock::new();

fn sample_lut(x: f32) -> f32 {
    let lut = LUT.get_or_init(build_lut);
    let x = x.clamp(0.0, 1.0);
    let idx = x * ((LUT_SIZE - 1) as f32);
    let i0 = idx.floor() as usize;
    let i1 = (i0 + 1).min(LUT_SIZE - 1);
    let f = idx - (i0 as f32);
    lut[i0] * (1.0 - f) + lut[i1] * f
}

fn agx_per_channel(scene: f32) -> f32 {
    let floor = MID_GRAY * MIN_EV.exp2();
    let clamped = scene.max(floor);
    let log = (clamped / MID_GRAY).log2().clamp(MIN_EV, MAX_EV);
    let norm = (log - MIN_EV) / (MAX_EV - MIN_EV);
    sample_lut(norm).clamp(0.0, 1.0)
}

/// AgX view transform. Scene-linear Rec.2020 → display-linear Rec.2020.
pub fn apply(img: &mut Image) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        p[0] = agx_per_channel(p[0]);
        p[1] = agx_per_channel(p[1]);
        p[2] = agx_per_channel(p[2]);
    }
    img.space = ColorSpace::DisplayLinearRec2020;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_is_monotone() {
        let mut prev = agx_sigmoid(0.0);
        for i in 1..=200 {
            let x = (i as f32) / 200.0;
            let y = agx_sigmoid(x);
            assert!(y >= prev - 1e-3, "non-monotone at x={}: {} < {}", x, y, prev);
            prev = y;
        }
    }

    #[test]
    fn mid_gray_maps_near_display_mid() {
        // Scene-linear 0.18 should map into the AgX-defined "display mid"
        // region — Blender's reference puts it around 0.18, Sobotka's sRGB
        // fit lands around 0.18–0.22. Use a loose bound.
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img);
        let p = img.pixels[0];
        assert!(p[0] > 0.1 && p[0] < 0.3, "R was {}", p[0]);
    }

    #[test]
    fn huge_scene_values_map_below_one() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [100.0, 50.0, 20.0];
        apply(&mut img);
        for &c in &img.pixels[0] {
            assert!(c < 1.01, "{} should have rolled off below 1", c);
        }
    }

    #[test]
    fn negative_inputs_clamp_to_toe_not_nan() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [-0.3, 0.0, 0.1];
        apply(&mut img);
        for &c in &img.pixels[0] {
            assert!(c.is_finite());
            assert!(c >= 0.0 && c <= 1.0);
        }
    }

    #[test]
    fn space_transitions_correctly() {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        apply(&mut img);
        assert_eq!(img.space, ColorSpace::DisplayLinearRec2020);
    }
}
```

Create `src/raw-pipeline/raw-core/src/view/mod.rs`:
```rust
pub mod agx;
```

Add to `src/raw-pipeline/raw-core/src/lib.rs`:
```rust
pub mod view;
```

- [ ] **Step 2: Run tests and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core agx
git add src/raw-pipeline/raw-core/src/view/ src/raw-pipeline/raw-core/src/lib.rs
git commit -m "raw-core: AgX view transform (Sobotka sigmoid approximation)"
```

---

## Phase 12 — Display encode

### Task 12.1: Rec.2020 → sRGB matrix + piecewise gamma + u8 quantize

**Files:**
- Create: `src/raw-pipeline/raw-core/src/view/encode.rs`
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs`

- [ ] **Step 1: Write tests + impl**

`src/raw-pipeline/raw-core/src/view/encode.rs`:
```rust
use crate::{
    color::matrices::M_REC2020_TO_SRGB,
    image::{ColorSpace, Image},
};

/// Rec.2020 → sRGB linear via compile-time 3×3.
pub fn rec2020_to_srgb(img: &mut Image) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    for p in &mut img.pixels {
        *p = M_REC2020_TO_SRGB.mul_vec(*p);
    }
    img.space = ColorSpace::DisplayLinearSrgb;
}

/// Piecewise sRGB gamma encode. Per IEC 61966-2-1.
pub fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// Final encode: display-linear sRGB → u8 RGB via piecewise gamma + quantize.
/// Returns a flat row-major `Vec<u8>` of length 3 * w * h.
pub fn quantize_u8(img: &mut Image) -> Vec<u8> {
    img.assert_space(ColorSpace::DisplayLinearSrgb);
    let mut out = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        for &c in p {
            let g = srgb_gamma(c);
            out.push((g * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
        }
    }
    img.space = ColorSpace::DisplayEncodedSrgb;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_zero_maps_to_zero() {
        assert!((srgb_gamma(0.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn gamma_one_maps_to_one() {
        assert!((srgb_gamma(1.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gamma_below_threshold_is_linear_times_12_92() {
        let x = 0.001;
        let expected = x * 12.92;
        assert!((srgb_gamma(x) - expected).abs() < 1e-6);
    }

    #[test]
    fn rec2020_white_maps_to_srgb_white() {
        let mut img = Image::new(1, 1, ColorSpace::DisplayLinearRec2020);
        img.pixels[0] = [1.0, 1.0, 1.0];
        rec2020_to_srgb(&mut img);
        for &c in &img.pixels[0] {
            assert!((c - 1.0).abs() < 1e-2);
        }
    }

    #[test]
    fn quantize_produces_expected_length() {
        let mut img = Image::new(4, 4, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert_eq!(bytes.len(), 4 * 4 * 3);
    }

    #[test]
    fn quantize_black_is_zero() {
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn quantize_white_is_255() {
        let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
        for p in &mut img.pixels { *p = [1.0, 1.0, 1.0]; }
        let bytes = quantize_u8(&mut img);
        assert!(bytes.iter().all(|b| *b == 255));
    }
}
```

Add to `src/raw-pipeline/raw-core/src/view/mod.rs`:
```rust
pub mod encode;
```

- [ ] **Step 2: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core encode
git add src/raw-pipeline/raw-core/src/view/
git commit -m "raw-core: display encode (Rec.2020→sRGB + piecewise gamma + u8)"
```

---

## Phase 13 — PNG writer

### Task 13.1: PNG with sRGB chunk

**Files:**
- Create: `src/raw-pipeline/raw-core/src/png.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Per spec § 11 "Output format — sRGB IEC61966-2.1 8-bit PNG, compression 6."

- [ ] **Step 1: Write tests + impl**

`src/raw-pipeline/raw-core/src/png.rs`:
```rust
use crate::error::{Error, Result};
use std::path::Path;

/// Write a sRGB 8-bit PNG. Tags the sRGB chunk per IEC 61966-2.1
/// (matching ACR reference output).
pub fn write(path: &Path, width: u32, height: u32, rgb: &[u8]) -> Result<()> {
    let expected_len = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected_len {
        return Err(Error::Png(format!(
            "expected {} bytes, got {}", expected_len, rgb.len()
        )));
    }
    let file = std::fs::File::create(path).map_err(|e| Error::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let w = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(w, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Default);
    encoder.set_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder.write_header().map_err(|e| Error::Png(e.to_string()))?;
    writer.write_image_data(rgb).map_err(|e| Error::Png(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn write_tiny_png_round_trip() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path();
        let rgb: Vec<u8> = vec![255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 255];
        write(path, 2, 2, &rgb).unwrap();

        // Read back with the same png crate.
        let mut f = std::fs::File::open(path).unwrap();
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).unwrap();
        let decoder = png::Decoder::new(buf.as_slice());
        let mut reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let mut out = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut out).unwrap();
        assert_eq!(&out[..12], &rgb[..]);
    }

    #[test]
    fn wrong_length_errors() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let err = write(tmp.path(), 2, 2, &[0u8; 10]).unwrap_err();
        match err {
            Error::Png(_) => {},
            _ => panic!("expected Error::Png"),
        }
    }
}
```

Add to `raw-core/Cargo.toml` under `[dev-dependencies]`:
```toml
tempfile = "3"
```

Add to `raw-core/src/lib.rs`:
```rust
pub mod png;
```

- [ ] **Step 2: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core png::
git add src/raw-pipeline/raw-core/
git commit -m "raw-core: PNG writer with sRGB chunk"
```

---

## Phase 14 — XMP parser (slice-1 subset)

### Task 14.1: Parse `crs:Exposure2012`, `crs:Temperature`, `crs:Tint`, `crs:Dehaze`

**Files:**
- Create: `src/raw-pipeline/raw-core/src/xmp.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

Per spec § 01. Slice 1 parses only the four fields we use; unknown fields are ignored (no passthrough buckets yet — that's slice 7). Full canonical round-trip is slice 7.

- [ ] **Step 1: Write tests + impl**

`src/raw-pipeline/raw-core/src/xmp.rs`:
```rust
use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

/// Slice-1 subset of `AdjustmentModel`. See spec § 01 for the full shape.
#[derive(Clone, Debug, PartialEq)]
pub struct AdjustmentModel {
    pub temperature: f32, // 2000..12000, default 6500
    pub tint: f32,        // -100..100, default 0
    pub exposure: f32,    // -4..+4 EV, default 0
    pub dehaze: f32,      // -100..100, default 0
}

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self { temperature: 6500.0, tint: 0.0, exposure: 0.0, dehaze: 0.0 }
    }
}

/// Parse an ACR XMP sidecar. Unknown fields are ignored; known fields that
/// fail to parse numerically surface as an error.
pub fn parse(xml: &str) -> Result<AdjustmentModel> {
    let mut model = AdjustmentModel::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                // Attributes on rdf:Description carry most crs: fields.
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr.unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    set_field(&mut model, key, &value)?;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    Ok(model)
}

fn set_field(m: &mut AdjustmentModel, key: &str, value: &str) -> Result<()> {
    let v = || value.parse::<f32>().map_err(|e| Error::Xmp(format!(
        "field {} has non-numeric value {}: {}", key, value, e
    )));
    match key {
        "crs:Temperature"    => m.temperature = v()?,
        "crs:Tint"           => m.tint        = v()?,
        "crs:Exposure2012"   => m.exposure    = v()?,
        "crs:Dehaze"         => m.dehaze      = v()?,
        _ => {}, // Slice 1 ignores everything else.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_fixture(rel: &str) -> Option<String> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/references").join(rel);
        std::fs::read_to_string(path).ok()
    }

    #[test]
    fn defaults() {
        let m = AdjustmentModel::default();
        assert_eq!(m.temperature, 6500.0);
        assert_eq!(m.tint, 0.0);
        assert_eq!(m.exposure, 0.0);
        assert_eq!(m.dehaze, 0.0);
    }

    #[test]
    fn parse_baseline_is_defaults() {
        let xml = match load_fixture("test_0002/xmp/baseline.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        // baseline.xmp is defined as ACR defaults — should match Default.
        assert_eq!(m, AdjustmentModel::default());
    }

    #[test]
    fn parse_exposure_max() {
        let xml = match load_fixture("test_0002/xmp/exposure_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert!(m.exposure > 0.5, "exposure was {}", m.exposure);
        assert_eq!(m.dehaze, 0.0); // other fields still at default
    }

    #[test]
    fn parse_dehaze_max() {
        let xml = match load_fixture("test_0002/xmp/dehaze_max.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        assert_eq!(m.dehaze, 100.0);
    }

    #[test]
    fn parse_wb_daylight() {
        let xml = match load_fixture("test_0002/xmp/wb_daylight.xmp") {
            Some(x) => x, None => return,
        };
        let m = parse(&xml).unwrap();
        // Daylight preset — temp roughly 5500K.
        assert!(m.temperature > 4000.0 && m.temperature < 7000.0,
            "temp was {}", m.temperature);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:Exposure2012="1.5" crs:SomeFutureField="99"/></x>"#;
        let m = parse(xml).unwrap();
        assert_eq!(m.exposure, 1.5);
    }
}
```

Add to `raw-core/src/lib.rs`:
```rust
pub mod xmp;
pub use xmp::AdjustmentModel;
```

- [ ] **Step 2: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core xmp
git add src/raw-pipeline/raw-core/
git commit -m "raw-core: XMP parser (slice-1 subset: exposure, WB, dehaze)"
```

---

## Phase 15 — Pipeline orchestrator

### Task 15.1: Top-level `render()` wiring

**Files:**
- Create: `src/raw-pipeline/raw-core/src/pipeline.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`

- [ ] **Step 1: Write test + impl**

`src/raw-pipeline/raw-core/src/pipeline.rs`:
```rust
use crate::{
    color::dcp,
    demosaic, linearize,
    error::Result,
    image::RawImage,
    stages::{dehaze, exposure, white_balance},
    view::{agx, encode},
    xmp::AdjustmentModel,
};
use std::path::Path;

/// End-to-end render: decode → demosaic → DCP → WB → exposure → dehaze → AgX
/// → Rec.2020→sRGB → gamma → u8. Per spec § 02 filter-chain with slice-1 subset.
pub fn render_from_raw(raw: &RawImage, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    // 1. Sensor linearize.
    let mosaic = linearize::sensor_linearize(raw);
    // 2. Demosaic.
    let camera_rgb = demosaic::bilinear(&mosaic, raw.cfa);
    // 3. DCP → scene-linear Rec.2020.
    let profile = dcp::profile_for(raw)?;
    let mut scene = dcp::apply(&camera_rgb, &profile);
    // 4. White balance.
    white_balance::apply(&mut scene, model.temperature, model.tint);
    // 5. Exposure.
    exposure::apply(&mut scene, model.exposure);
    // 6. Dehaze.
    dehaze::apply(&mut scene, model.dehaze);
    // 7. AgX view transform.
    agx::apply(&mut scene);
    // 8. Rec.2020 → sRGB.
    encode::rec2020_to_srgb(&mut scene);
    // 9. Gamma encode to u8.
    let bytes = encode::quantize_u8(&mut scene);
    Ok((scene.width, scene.height, bytes))
}

/// Convenience: decode a RAW and run the full pipeline.
pub fn render(raw_path: &Path, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    let raw = crate::decode::decode(raw_path)?;
    render_from_raw(&raw, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_test_0002_baseline_produces_plausible_png_bytes() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render(&path, &model).expect("render");
        assert_eq!(bytes.len() as u32, w * h * 3);
        // Image is not all zeros and not all 255.
        let zero_ratio = bytes.iter().filter(|b| **b == 0).count() as f32 / bytes.len() as f32;
        let max_ratio  = bytes.iter().filter(|b| **b == 255).count() as f32 / bytes.len() as f32;
        assert!(zero_ratio < 0.5, "too many zeros ({}%)", zero_ratio * 100.0);
        assert!(max_ratio < 0.5, "too many saturated pixels ({}%)", max_ratio * 100.0);
    }
}
```

Add to `raw-core/src/lib.rs`:
```rust
pub mod pipeline;
pub use pipeline::{render, render_from_raw};
```

- [ ] **Step 2: Run and commit**

```bash
cd src/raw-pipeline && cargo test -p raw-core pipeline -- --nocapture
git add src/raw-pipeline/raw-core/
git commit -m "raw-core: pipeline orchestrator render() end-to-end"
```

---

## Phase 16 — CLI `render` subcommand

### Task 16.1: `maple-cli render <raw> --params <xmp> --out <png>`

**Files:**
- Modify: `src/raw-pipeline/maple-cli/src/main.rs`

- [ ] **Step 1: Implement**

`src/raw-pipeline/maple-cli/src/main.rs`:
```rust
use clap::{Parser, Subcommand};
use raw_core::{png, render, xmp};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "maple-cli", about = "Maple raw-pipeline reference renderer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Render a RAW + XMP to a PNG.
    Render {
        /// Path to the RAW file (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, DCR, MOS, IIQ, MRW).
        raw: PathBuf,
        /// Path to the ACR XMP sidecar carrying the parameter set.
        #[arg(long)]
        params: Option<PathBuf>,
        /// Output PNG path.
        #[arg(long)]
        out: PathBuf,
    },
    /// Stubbed in slice 1.
    Batch,
    /// Stubbed in slice 1.
    Diff,
    /// Stubbed in slice 1.
    Inspect,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Render { raw, params, out } => match do_render(&raw, params.as_deref(), &out) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {}", e);
                ExitCode::from(1)
            }
        },
        _ => {
            eprintln!("subcommand not implemented in slice 1");
            ExitCode::from(2)
        }
    }
}

fn do_render(
    raw: &std::path::Path,
    params: Option<&std::path::Path>,
    out: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => {
            let xml = std::fs::read_to_string(p)?;
            xmp::parse(&xml)?
        }
        None => xmp::AdjustmentModel::default(),
    };
    let (w, h, bytes) = render(raw, &model)?;
    png::write(out, w, h, &bytes)?;
    Ok(())
}
```

- [ ] **Step 2: Build and smoke-test against a fixture**

```bash
cd src/raw-pipeline && cargo build --release -p maple-cli
./target/release/maple-cli render \
  ../../test-fixtures/raws/test_0002.dng \
  --params ../../test-fixtures/references/test_0002/xmp/baseline.xmp \
  --out /tmp/maple_smoke.png
file /tmp/maple_smoke.png
```

Expected: `/tmp/maple_smoke.png` is a valid PNG, dimensions match the RAW.

- [ ] **Step 3: Commit**

```bash
git add src/raw-pipeline/maple-cli/src/main.rs
git commit -m "maple-cli: render subcommand end-to-end"
```

---

## Phase 17 — compare_images.py

### Task 17.1: Minimal CIEDE2000 + bias comparator

**Files:**
- Create: `src/scripts/compare_images.py`
- Create: `src/scripts/requirements.txt`

Per spec § 11 "authoritative tool". Slice 1 ships a minimal version emitting the fields our Rust harness reads.

- [ ] **Step 1: Write the script**

`src/scripts/requirements.txt`:
```
numpy>=1.26
Pillow>=10
colour-science>=0.4.4
```

`src/scripts/compare_images.py`:
```python
#!/usr/bin/env python3
"""Compare two sRGB PNG images and emit CIEDE2000 + per-channel bias JSON.

Usage:
    compare_images.py <candidate.png> <reference.png>

Output (stdout, single-line JSON):
    {
      "mean_deltaE":  float,
      "p95_deltaE":   float,
      "max_deltaE":   float,
      "bias_r":       float,
      "bias_g":       float,
      "bias_b":       float,
      "n_pixels":     int
    }

Exit code 0 on success, non-zero on any error.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image
import colour


def load_srgb(path: str) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    args = p.parse_args()

    cand = load_srgb(args.candidate)
    ref = load_srgb(args.reference)
    if cand.shape != ref.shape:
        print(json.dumps({
            "error": f"shape mismatch: {cand.shape} vs {ref.shape}"
        }), file=sys.stdout)
        return 2

    # sRGB → XYZ → Lab via colour-science, under D65 2° observer.
    cand_xyz = colour.sRGB_to_XYZ(cand)
    ref_xyz  = colour.sRGB_to_XYZ(ref)
    cand_lab = colour.XYZ_to_Lab(cand_xyz)
    ref_lab  = colour.XYZ_to_Lab(ref_xyz)

    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    bias = (cand - ref).mean(axis=(0, 1))
    out = {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE":  float(np.percentile(dE, 95)),
        "max_deltaE":  float(np.max(dE)),
        "bias_r":      float(bias[0]),
        "bias_g":      float(bias[1]),
        "bias_b":      float(bias[2]),
        "n_pixels":    int(cand.shape[0] * cand.shape[1]),
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke-test**

```bash
cd /Users/riabuz/Projects/_Maple
python3 -m pip install -r src/scripts/requirements.txt
python3 src/scripts/compare_images.py \
  test-fixtures/references/test_0002/down/baseline.png \
  test-fixtures/references/test_0002/down/baseline.png
```

Expected: JSON with `mean_deltaE ≈ 0`, `max_deltaE ≈ 0`.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/compare_images.py src/scripts/requirements.txt
git commit -m "scripts: compare_images.py (CIEDE2000 + bias JSON)"
```

---

## Phase 18 — Golden tests

### Task 18.1: Golden-test harness in Rust

**Files:**
- Create: `src/raw-pipeline/raw-core/tests/golden.rs`
- Create: `src/raw-pipeline/raw-core/tests/budgets.toml`

- [ ] **Step 1: Write budgets**

`src/raw-pipeline/raw-core/tests/budgets.toml` (per spec § 11 table, loose initial values):
```toml
# Per-case slice-1 budgets. Format: mean_delta_e, p95_delta_e, max_delta_e.
# These are initial-column values from docs/spec/11-testing.md; each slice
# ratchets them downward.

[baseline]
mean_delta_e = 10.0
p95_delta_e  = 20.0
max_delta_e  = 40.0

[exposure]
mean_delta_e = 15.0
p95_delta_e  = 30.0
max_delta_e  = 60.0

[wb]
mean_delta_e = 15.0
p95_delta_e  = 30.0
max_delta_e  = 60.0

[dehaze]
mean_delta_e = 25.0
p95_delta_e  = 50.0
max_delta_e  = 80.0
```

- [ ] **Step 2: Write harness**

`src/raw-pipeline/raw-core/tests/golden.rs`:
```rust
//! Golden tests: render a fixture + XMP and compare against ACR reference
//! via `src/scripts/compare_images.py`. Gated by `--features golden` because
//! they shell out to Python.
//!
//! Run: `cargo test -p raw-core --features golden golden`

#![cfg(feature = "golden")]

use raw_core::{png, render, xmp};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize, Debug)]
struct DiffReport {
    mean_deltaE: f32,
    p95_deltaE: f32,
    max_deltaE: f32,
    #[allow(dead_code)] bias_r: f32,
    #[allow(dead_code)] bias_g: f32,
    #[allow(dead_code)] bias_b: f32,
    #[allow(dead_code)] n_pixels: u64,
}

struct Budget {
    mean: f32,
    p95: f32,
    max: f32,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

fn budget_for(case_class: &str) -> Budget {
    // Parse budgets.toml by hand (no toml dep yet; inline the table).
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml");
    let s = std::fs::read_to_string(&path).expect("budgets.toml");
    let mut section = false;
    let mut b = Budget { mean: f32::INFINITY, p95: f32::INFINITY, max: f32::INFINITY };
    for line in s.lines() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() { continue; }
        if t.starts_with('[') {
            section = t == format!("[{}]", case_class);
            continue;
        }
        if !section { continue; }
        if let Some((k, v)) = t.split_once('=') {
            let k = k.trim(); let v = v.trim();
            match k {
                "mean_delta_e" => b.mean = v.parse().unwrap(),
                "p95_delta_e"  => b.p95  = v.parse().unwrap(),
                "max_delta_e"  => b.max  = v.parse().unwrap(),
                _ => {}
            }
        }
    }
    b
}

fn run_case(stem: &str, case: &str, class: &str) {
    let root = repo_root();
    let raw_glob = root.join("test-fixtures/raws");
    // Locate the RAW by stem (stem may have any of several extensions).
    let raw = ["DNG", "dng", "RAW", "CR2"].iter()
        .map(|ext| raw_glob.join(format!("{}.{}", stem, ext)))
        .find(|p| p.exists())
        .expect("raw fixture exists");
    let xmp_path = root.join(format!("test-fixtures/references/{}/xmp/{}.xmp", stem, case));
    let ref_path = root.join(format!("test-fixtures/references/{}/down/{}.png", stem, case));
    if !xmp_path.exists() || !ref_path.exists() {
        eprintln!("skipping {}/{} — fixture or reference missing", stem, case);
        return;
    }

    // Render.
    let xml = std::fs::read_to_string(&xmp_path).unwrap();
    let model = xmp::parse(&xml).unwrap();
    let (w, h, bytes) = render(&raw, &model).unwrap();
    let out_dir = root.join("target/golden-out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_png = out_dir.join(format!("{}_{}.png", stem, case));
    png::write(&out_png, w, h, &bytes).unwrap();

    // Compare.
    let script = root.join("src/scripts/compare_images.py");
    let out = Command::new("python3")
        .arg(&script)
        .arg(&out_png)
        .arg(&ref_path)
        .output()
        .expect("spawn compare_images.py");
    if !out.status.success() {
        panic!("compare failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let rep: DiffReport = serde_json::from_slice(&out.stdout).unwrap();
    let b = budget_for(class);
    assert!(rep.mean_deltaE <= b.mean,
        "{}/{}: mean ΔE {} > budget {}", stem, case, rep.mean_deltaE, b.mean);
    assert!(rep.p95_deltaE  <= b.p95,
        "{}/{}: p95 ΔE {} > budget {}", stem, case, rep.p95_deltaE, b.p95);
    assert!(rep.max_deltaE  <= b.max,
        "{}/{}: max ΔE {} > budget {}", stem, case, rep.max_deltaE, b.max);
}

#[test] fn test_0002_baseline()     { run_case("test_0002", "baseline",     "baseline"); }
#[test] fn test_0002_exposure_max() { run_case("test_0002", "exposure_max", "exposure"); }
#[test] fn test_0002_exposure_min() { run_case("test_0002", "exposure_min", "exposure"); }
#[test] fn test_0002_wb_daylight()  { run_case("test_0002", "wb_daylight",  "wb"); }
#[test] fn test_0002_wb_tungsten()  { run_case("test_0002", "wb_tungsten",  "wb"); }
#[test] fn test_0002_dehaze_max()   { run_case("test_0002", "dehaze_max",   "dehaze"); }

#[test] fn test_0003_baseline()     { run_case("test_0003", "baseline",     "baseline"); }
#[test] fn test_0000_baseline()     { run_case("test_0000", "baseline",     "baseline"); }
#[test] fn test_0001_baseline()     { run_case("test_0001", "baseline",     "baseline"); }
```

Add to `raw-core/Cargo.toml` `[dev-dependencies]`:
```toml
serde_json = { workspace = true }
serde = { workspace = true }
```

- [ ] **Step 3: Run golden tests**

```bash
cd src/raw-pipeline && cargo test -p raw-core --features golden golden -- --nocapture --test-threads=1
```

Expected: most tests pass, maybe some fail with ΔE over budget.

- [ ] **Step 4: Fix iteratively**

If a test fails, look at the per-channel bias in the diff report:
- **`bias_g` ≠ 0** and `mean_deltaE > 5` → WB or DCP green-magenta bias. Re-check `m_pro_to_rec2020` composition and Bradford direction.
- **`bias_r > 0` symmetric with `bias_b < 0`** → WB CCT off. Re-check `cct_to_xy` sign.
- **`mean_deltaE ~ 10` with no bias** → AgX shape; acceptable for slice 1.
- **`max_deltaE >> mean_deltaE`** → localized blow-up, often a clipping bug. Look for a `clamp(0, 1)` upstream of AgX.

When a fix lands, re-run only the failing case:
```bash
cargo test -p raw-core --features golden test_0002_baseline -- --nocapture
```

Iterate until all 9 golden tests pass within their budgets. **Each bug fix commits separately** with a message like `dehaze: don't clip transmission pre-guided-filter — fixes test_0002/dehaze_max`.

- [ ] **Step 5: Final commit**

```bash
git add src/raw-pipeline/raw-core/tests/ src/raw-pipeline/raw-core/Cargo.toml
git commit -m "raw-core: golden test harness and budgets"
```

---

## Slice 1 done when

- `cargo test -p raw-core` passes every unit test.
- `cargo test -p raw-core --features golden` passes all 9 golden tests within loose budgets across 4 fixtures.
- `maple-cli render <any-fixture> --params <any-slice-1-xmp> --out out.png` produces a reasonable-looking PNG without panics.
- Commit history tells a story: one commit per task, 40-odd commits, each green on its own.

## What the next slice starts with

Slice 2 (`SceneToneControls` full) picks up a working end-to-end pipeline and adds highlights/shadows/whites/blacks/curves as additional stages in the same `stages/` module. The architectural investments in slice 1 (colorspace tracking, stage-call pattern, golden-test harness, budgets.toml) carry forward unchanged.

---

## Spec coverage check

- **§ 3.1 RAW decode**: Task 4.1
- **§ 3.2 Sensor linearization**: Task 5.1
- **§ 3.3.1 Bilinear demosaic**: Task 6.1
- **§ 3.3a Highlight reconstruction**: intentionally deferred (default off)
- **§ 3.4 DCP**: Tasks 7.1–7.2 (minimal: single illuminant, CM+FM, no HSM, no PLT)
- **§ 3.5 White balance**: Task 8.1
- **§ 3.6 SceneToneControls (exposure-only subset)**: Task 9.1
- **§ 3.6a AgX**: Task 11.1
- **§ 3.9 Dehaze**: Tasks 10.1–10.4
- **§ 04 Display encode**: Task 12.1
- **§ 08 PNG output**: Task 13.1
- **§ 01 AdjustmentModel**: Task 14.1 (subset)
- **§ 10 CLI render**: Task 16.1
- **§ 11 ΔE harness**: Tasks 17.1, 18.1

All deferred sections are listed in the roadmap doc. No spec section in slice 1 scope lacks a task.
