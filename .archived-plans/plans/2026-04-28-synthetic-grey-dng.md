# Synthetic Grey DNG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a synthetic Bayer DNG generator and a test harness that asserts pipeline neutrality (R=G=B) and flatness (per-pixel = mean) invariants on the rendered output, gated by a new CI script.

**Architecture:** Hand-rolled minimal DNG writer in `raw-core` behind a `test-support` Cargo feature, paired with integration tests at two pipeline checkpoints (scene-linear and display-encoded sRGB) and a thin CLI example.

**Tech Stack:** Rust 2021. New runtime deps: none. Existing dev-deps reused: `tempfile`. The example uses `clap` (already in workspace).

**Spec:** `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`

---

## File Structure

| File                                                  | Status   | Responsibility                                                            |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `src/raw-pipeline/raw-core/Cargo.toml`                | modify   | Add `test-support` feature                                                |
| `src/raw-pipeline/raw-core/src/lib.rs`                | modify   | Gate `pub mod test_support;` behind feature                               |
| `src/raw-pipeline/raw-core/src/test_support/mod.rs`   | create   | Module root, re-exports                                                   |
| `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs` | create | DNG writer + math helpers + `SyntheticGreyDng` struct                    |
| `src/raw-pipeline/raw-core/tests/grey_invariants.rs`  | create   | Integration tests for both checkpoints + sweep                            |
| `src/raw-pipeline/raw-core/examples/synth-grey.rs`    | create   | CLI wrapper for ad-hoc DNG generation                                     |
| `src/scripts/test_synthetic_grey.sh`                  | create   | CI gate, sibling of `test_color_pipeline.sh`                              |

The DNG writer is split into pure helpers (math, byte primitives, IFD assembly) and a thin top-level `SyntheticGreyDng::write_to_bytes` that composes them. Each helper is independently testable. No file exceeds ~350 LOC.

---

## Task 1: `test-support` Cargo feature scaffold

**Files:**
- Modify: `src/raw-pipeline/raw-core/Cargo.toml`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs`
- Create: `src/raw-pipeline/raw-core/src/test_support/mod.rs`

- [ ] **Step 1: Add the feature flag to Cargo.toml**

In `src/raw-pipeline/raw-core/Cargo.toml`, add `test-support = []` to `[features]`:

```toml
[features]
# Opt-in integration tests that shell out to compare_images.py.
golden = []
high-quality-demosaic = []
# Test-only DNG synthesis helpers. NEVER enable in shipping artifacts.
test-support = []
```

- [ ] **Step 2: Gate the module in lib.rs**

In `src/raw-pipeline/raw-core/src/lib.rs`, find the `pub mod` block and add:

```rust
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
```

Place it after the existing `pub mod` declarations alphabetically (after `pub mod tiff;`).

- [ ] **Step 3: Create the empty module root**

Create `src/raw-pipeline/raw-core/src/test_support/mod.rs`:

```rust
//! Test-only helpers. Gated by the `test-support` feature. These do NOT
//! ship in `libraw_ffi.a` (Apple xcframework) or `raw-wasm` binaries —
//! the feature is opt-in and only enabled by Cargo when running tests
//! or the `synth-grey` example.

pub mod synth_dng;
```

- [ ] **Step 4: Create an empty `synth_dng.rs` placeholder**

Create `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs` with a single line:

```rust
//! Synthetic Bayer DNG writer — see Task 2 onward.
```

- [ ] **Step 5: Verify compilation**

```bash
cd src/raw-pipeline
cargo build -p raw-core --features test-support
```

Expected: clean build, no warnings.

- [ ] **Step 6: Verify the feature gate actually gates**

```bash
cd src/raw-pipeline
cargo build -p raw-core
```

Expected: clean build (the new module is not visible without the feature).

- [ ] **Step 7: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/Cargo.toml \
        src/raw-pipeline/raw-core/src/lib.rs \
        src/raw-pipeline/raw-core/src/test_support/
git commit -m "feat(raw-core): add test-support feature scaffold for DNG synthesis"
```

---

## Task 2: Per-channel raw value math (TDD)

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`

The function we're building computes the 16-bit raw values that, after Maple's pipeline subtracts black, normalises by the dynamic range, and applies WB multipliers, recover the requested scene-linear neutral `L` for every channel.

- [ ] **Step 1: Write the failing test**

Add to the bottom of `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`:

```rust
/// Compute per-CFA-position 16-bit raw values that decode to a uniform
/// scene-linear neutral `linear_value` after black subtract, dynamic-range
/// normalisation, and WB. `as_shot_neutral` follows DNG semantics
/// (camera reading of a neutral, G-normalised). Returns `(raw_r, raw_g, raw_b)`.
pub(crate) fn compute_raw_values(
    linear_value: f32,
    as_shot_neutral: [f32; 3],
    black_level: u16,
    white_level: u16,
) -> (u16, u16, u16) {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_values_for_l_018_d65_balance() {
        // L = 0.18, AsShotNeutral = (0.5, 1.0, 0.5) → WB = (2.0, 1.0, 2.0).
        // raw = BL + (L / WB) * (WL - BL) = 0 + (0.18/WB) * 65535.
        //   R: 0.18/2.0 * 65535 = 5898.15 → 5898
        //   G: 0.18/1.0 * 65535 = 11796.30 → 11796
        //   B: 0.18/2.0 * 65535 = 5898.15 → 5898
        let (r, g, b) = compute_raw_values(0.18, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 5898);
        assert_eq!(g, 11796);
        assert_eq!(b, 5898);
    }

    #[test]
    fn raw_values_clamp_to_white_level() {
        // L = 1.0 with WB_G = 1.0 saturates G at WL. Other channels also
        // saturate because their WB > 1.
        let (r, g, b) = compute_raw_values(1.0, [0.5, 1.0, 0.5], 0, 65535);
        assert_eq!(r, 65535);
        assert_eq!(g, 65535);
        assert_eq!(b, 65535);
    }

    #[test]
    fn raw_values_zero_for_zero_l() {
        let (r, g, b) = compute_raw_values(0.0, [0.5, 1.0, 0.5], 100, 65535);
        assert_eq!(r, 100);
        assert_eq!(g, 100);
        assert_eq!(b, 100);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::raw_values 2>&1 | tail -20
```

Expected: PANIC `not yet implemented` from the `todo!()`.

- [ ] **Step 3: Implement the function**

Replace the `todo!()` body with:

```rust
pub(crate) fn compute_raw_values(
    linear_value: f32,
    as_shot_neutral: [f32; 3],
    black_level: u16,
    white_level: u16,
) -> (u16, u16, u16) {
    let bl = black_level as f32;
    let wl = white_level as f32;
    let range = wl - bl;
    let wb = [
        1.0 / as_shot_neutral[0],
        1.0 / as_shot_neutral[1],
        1.0 / as_shot_neutral[2],
    ];
    let raw = |w: f32| -> u16 {
        let v = bl + (linear_value / w) * range;
        v.round().clamp(0.0, u16::MAX as f32) as u16
    };
    (raw(wb[0]), raw(wb[1]), raw(wb[2]))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::raw_values 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/test_support/synth_dng.rs
git commit -m "feat(raw-core): per-CFA-position raw value math for synthetic grey"
```

---

## Task 3: Low-level TIFF byte primitives (TDD)

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`

Add little-endian write helpers and an IFD entry encoder. These are pure functions over byte buffers — easy to unit-test.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `synth_dng.rs`:

```rust
    #[test]
    fn writes_u16_le() {
        let mut buf = Vec::new();
        write_u16_le(&mut buf, 0x1234);
        assert_eq!(buf, vec![0x34, 0x12]);
    }

    #[test]
    fn writes_u32_le() {
        let mut buf = Vec::new();
        write_u32_le(&mut buf, 0xDEAD_BEEF);
        assert_eq!(buf, vec![0xEF, 0xBE, 0xAD, 0xDE]);
    }

    #[test]
    fn writes_rational_le() {
        let mut buf = Vec::new();
        write_rational(&mut buf, 1, 2);
        assert_eq!(buf, vec![1, 0, 0, 0, 2, 0, 0, 0]);
    }

    #[test]
    fn writes_srational_le() {
        let mut buf = Vec::new();
        write_srational(&mut buf, -1, 2);
        // -1 as i32 little-endian = 0xFFFFFFFF
        assert_eq!(buf, vec![0xFF, 0xFF, 0xFF, 0xFF, 2, 0, 0, 0]);
    }
```

- [ ] **Step 2: Run tests to verify they fail (compile error)**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::writes 2>&1 | tail -10
```

Expected: compile errors — `write_u16_le` etc. unresolved.

- [ ] **Step 3: Implement the helpers**

Add above the `compute_raw_values` function:

```rust
pub(crate) fn write_u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_rational(buf: &mut Vec<u8>, num: u32, den: u32) {
    write_u32_le(buf, num);
    write_u32_le(buf, den);
}

pub(crate) fn write_srational(buf: &mut Vec<u8>, num: i32, den: i32) {
    buf.extend_from_slice(&num.to_le_bytes());
    buf.extend_from_slice(&den.to_le_bytes());
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::writes 2>&1 | tail -10
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/test_support/synth_dng.rs
git commit -m "feat(raw-core): TIFF byte primitives for synthetic DNG writer"
```

---

## Task 4: IFD entry + IFD writer

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`

A TIFF IFD is `[u16 count][12-byte entry × count][u32 next_ifd_offset]`. Each entry is `[u16 tag][u16 type][u32 count][4-byte value-or-offset]`. Values longer than 4 bytes are stored elsewhere in the file and the entry holds an offset.

We model this with an `IfdEntry` enum — variants per type — and an `Ifd` struct that handles the offset bookkeeping when serialised.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn ifd_with_two_short_entries_serialises_to_expected_bytes() {
        // Build IFD with two SHORT entries (each fits in the 4-byte value
        // slot, no overflow data). ImageWidth = 64, ImageLength = 64.
        // Layout (file_offset = 0 for this test):
        //   [u16 count=2]
        //   [tag=256, type=3 (SHORT), count=1, value=64 (in low 2 bytes)]
        //   [tag=257, type=3 (SHORT), count=1, value=64]
        //   [u32 next=0]
        // = 2 + 12 + 12 + 4 = 30 bytes
        let mut ifd = Ifd::new();
        ifd.add_short(256, 64);
        ifd.add_short(257, 64);
        let mut buf = Vec::new();
        ifd.serialise_into(&mut buf, /*file_offset_of_ifd*/ 0);
        assert_eq!(buf.len(), 30);
        // Count
        assert_eq!(&buf[0..2], &[2, 0]);
        // First entry: tag 256 (0x0100), type 3, count 1, value 64
        assert_eq!(&buf[2..4],  &[0x00, 0x01]);   // tag
        assert_eq!(&buf[4..6],  &[3, 0]);          // type = SHORT
        assert_eq!(&buf[6..10], &[1, 0, 0, 0]);    // count = 1
        assert_eq!(&buf[10..14], &[64, 0, 0, 0]);  // value = 64 (padded)
        // Next-IFD offset = 0
        assert_eq!(&buf[26..30], &[0, 0, 0, 0]);
    }

    #[test]
    fn ifd_with_overflow_entry_emits_data_after_directory() {
        // CFAPattern (tag 33422) has 4 BYTEs — fits in value slot exactly.
        // Use ColorMatrix1 (tag 50721) instead: 9 SRATIONAL = 72 bytes,
        // overflows. The IFD entry holds an offset; the data bytes follow.
        let mut ifd = Ifd::new();
        ifd.add_srationals(50721, vec![(1, 1); 9]);
        let mut buf = Vec::new();
        let file_offset = 100u32;
        ifd.serialise_into(&mut buf, file_offset);
        // 2 (count) + 12 (entry) + 4 (next) + 72 (overflow data) = 90 bytes
        assert_eq!(buf.len(), 90);
        // Entry's value slot is the absolute file offset of the overflow:
        // file_offset + 2 + 12 + 4 = 118.
        let expected_overflow_offset: u32 = file_offset + 2 + 12 + 4;
        assert_eq!(&buf[10..14], &expected_overflow_offset.to_le_bytes());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::ifd_ 2>&1 | tail -10
```

Expected: compile errors — `Ifd` unresolved.

- [ ] **Step 3: Implement `IfdEntry` and `Ifd`**

Add above the existing helpers:

```rust
const TYPE_BYTE: u16 = 1;
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;
const TYPE_SRATIONAL: u16 = 10;

#[derive(Clone)]
pub(crate) enum IfdEntry {
    Short(u16, u16),                       // tag, value (single)
    Shorts(u16, Vec<u16>),                 // tag, values
    Long(u16, u32),                        // tag, value (single)
    Bytes(u16, Vec<u8>),                   // tag, values (count = len)
    Ascii(u16, String),                    // tag, NUL-terminated ASCII
    Rationals(u16, Vec<(u32, u32)>),       // tag, num/den pairs
    SRationals(u16, Vec<(i32, i32)>),      // tag, signed num/den
}

impl IfdEntry {
    fn tag(&self) -> u16 {
        match self {
            Self::Short(t, _)      => *t,
            Self::Shorts(t, _)     => *t,
            Self::Long(t, _)       => *t,
            Self::Bytes(t, _)      => *t,
            Self::Ascii(t, _)      => *t,
            Self::Rationals(t, _)  => *t,
            Self::SRationals(t, _) => *t,
        }
    }

    fn type_id(&self) -> u16 {
        match self {
            Self::Short(_, _) | Self::Shorts(_, _) => TYPE_SHORT,
            Self::Long(_, _)                       => TYPE_LONG,
            Self::Bytes(_, _)                      => TYPE_BYTE,
            Self::Ascii(_, _)                      => TYPE_ASCII,
            Self::Rationals(_, _)                  => TYPE_RATIONAL,
            Self::SRationals(_, _)                 => TYPE_SRATIONAL,
        }
    }

    fn count(&self) -> u32 {
        match self {
            Self::Short(_, _)        => 1,
            Self::Shorts(_, v)       => v.len() as u32,
            Self::Long(_, _)         => 1,
            Self::Bytes(_, v)        => v.len() as u32,
            Self::Ascii(_, s)        => s.len() as u32 + 1, // includes NUL
            Self::Rationals(_, v)    => v.len() as u32,
            Self::SRationals(_, v)   => v.len() as u32,
        }
    }

    /// Total byte size of the value payload (whether inline or overflow).
    fn payload_bytes(&self) -> usize {
        let elem = match self {
            Self::Short(_, _) | Self::Shorts(_, _) => 2,
            Self::Long(_, _)                       => 4,
            Self::Bytes(_, _)                      => 1,
            Self::Ascii(_, _)                      => 1,
            Self::Rationals(_, _)                  => 8,
            Self::SRationals(_, _)                 => 8,
        };
        (self.count() as usize) * elem
    }

    /// Serialise the value payload into a fresh buffer (either the full
    /// payload for overflow, or the same bytes that go in the inline value
    /// slot — caller pads to 4 bytes when inline).
    fn payload_bytes_vec(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        match self {
            Self::Short(_, v) | Self::Shorts(_, _) => {
                let vs: &[u16] = match self {
                    Self::Short(_, v) => std::slice::from_ref(v),
                    Self::Shorts(_, v) => v.as_slice(),
                    _ => unreachable!(),
                };
                for &x in vs { write_u16_le(&mut buf, x); }
            }
            Self::Long(_, v) => write_u32_le(&mut buf, *v),
            Self::Bytes(_, v) => buf.extend_from_slice(v),
            Self::Ascii(_, s) => {
                buf.extend_from_slice(s.as_bytes());
                buf.push(0); // NUL
            }
            Self::Rationals(_, v) => {
                for (n, d) in v { write_rational(&mut buf, *n, *d); }
            }
            Self::SRationals(_, v) => {
                for (n, d) in v { write_srational(&mut buf, *n, *d); }
            }
        }
        buf
    }
}

pub(crate) struct Ifd {
    entries: Vec<IfdEntry>,
}

impl Ifd {
    pub(crate) fn new() -> Self { Self { entries: Vec::new() } }

    pub(crate) fn add_short(&mut self, tag: u16, value: u16)         { self.entries.push(IfdEntry::Short(tag, value)); }
    pub(crate) fn add_shorts(&mut self, tag: u16, values: Vec<u16>)  { self.entries.push(IfdEntry::Shorts(tag, values)); }
    pub(crate) fn add_long(&mut self, tag: u16, value: u32)          { self.entries.push(IfdEntry::Long(tag, value)); }
    pub(crate) fn add_bytes(&mut self, tag: u16, values: Vec<u8>)    { self.entries.push(IfdEntry::Bytes(tag, values)); }
    pub(crate) fn add_ascii(&mut self, tag: u16, s: &str)            { self.entries.push(IfdEntry::Ascii(tag, s.to_string())); }
    pub(crate) fn add_rationals(&mut self, tag: u16, v: Vec<(u32, u32)>)  { self.entries.push(IfdEntry::Rationals(tag, v)); }
    pub(crate) fn add_srationals(&mut self, tag: u16, v: Vec<(i32, i32)>) { self.entries.push(IfdEntry::SRationals(tag, v)); }

    /// Serialise: sort entries by tag, then write
    ///   [u16 count][12-byte entry × N][u32 next=0][overflow bytes...]
    /// `file_offset` is the absolute file position where this IFD starts —
    /// needed to compute correct overflow-data offsets.
    pub(crate) fn serialise_into(mut self, buf: &mut Vec<u8>, file_offset: u32) {
        self.entries.sort_by_key(|e| e.tag());
        let n = self.entries.len() as u16;

        // Directory size: 2 (count) + 12 * n + 4 (next-IFD).
        let dir_size = 2 + 12 * (n as u32) + 4;
        let mut overflow_cursor = file_offset + dir_size;
        let mut overflow_buf: Vec<u8> = Vec::new();

        write_u16_le(buf, n);
        for entry in &self.entries {
            write_u16_le(buf, entry.tag());
            write_u16_le(buf, entry.type_id());
            write_u32_le(buf, entry.count());
            let payload = entry.payload_bytes_vec();
            if payload.len() <= 4 {
                // Inline. Pad to 4 bytes with zeros.
                let mut padded = payload.clone();
                padded.resize(4, 0);
                buf.extend_from_slice(&padded);
            } else {
                // Overflow. Value slot holds absolute file offset.
                write_u32_le(buf, overflow_cursor);
                overflow_cursor += payload.len() as u32;
                overflow_buf.extend_from_slice(&payload);
                // Pad overflow to even byte boundary per TIFF spec.
                if overflow_buf.len() % 2 != 0 {
                    overflow_buf.push(0);
                    overflow_cursor += 1;
                }
            }
        }
        // Next-IFD offset (0 = last).
        write_u32_le(buf, 0);
        // Overflow data follows directory.
        buf.extend_from_slice(&overflow_buf);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::ifd_ 2>&1 | tail -20
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/test_support/synth_dng.rs
git commit -m "feat(raw-core): TIFF IFD assembly with overflow-offset bookkeeping"
```

---

## Task 5: `SyntheticGreyDng` struct + `write_to_bytes`

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`

The top-level public API. Composes the helpers into a complete DNG byte stream. We use a single-IFD layout (no SubIFD) to keep the writer simple — `decode.rs` walks the IFD tree recursively (`find_entry_recursive`) so it picks up the raw image regardless of where it lives.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn write_to_bytes_emits_tiff_magic() {
        let dng = SyntheticGreyDng::default();
        let bytes = dng.write_to_bytes();
        // TIFF II (little-endian) header: 0x49 0x49 0x2A 0x00
        assert_eq!(&bytes[0..4], &[0x49, 0x49, 0x2A, 0x00]);
        // IFD0 offset is at bytes 4..8, must be >= 8.
        let ifd0 = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        assert!(ifd0 >= 8, "IFD0 offset {} must be >= 8", ifd0);
    }

    #[test]
    fn write_to_bytes_pixel_buffer_size_matches_dimensions() {
        let dng = SyntheticGreyDng {
            width: 32,
            height: 32,
            ..Default::default()
        };
        let bytes = dng.write_to_bytes();
        // Pixel buffer = width * height * 2 bytes (16-bit). Total file
        // size must include header (8) + IFD + overflow + pixels.
        let pixel_bytes = 32 * 32 * 2;
        assert!(bytes.len() >= 8 + pixel_bytes,
            "file size {} too small for {} pixel bytes", bytes.len(), pixel_bytes);
    }
```

- [ ] **Step 2: Run tests to verify they fail (compile error)**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::write_to_bytes 2>&1 | tail -10
```

Expected: compile errors — `SyntheticGreyDng` unresolved.

- [ ] **Step 3: Implement the struct, defaults, and writer**

Add at the top of the file (after `use` statements; below the constants):

```rust
use crate::color::illuminant::Illuminant;
use crate::image::CfaPattern;
use std::io;
use std::path::Path;

// DNG-specific TIFF tag IDs. Subset of what raw-core's decoder reads.
const TAG_NEW_SUBFILE_TYPE:        u16 = 254;
const TAG_IMAGE_WIDTH:             u16 = 256;
const TAG_IMAGE_LENGTH:            u16 = 257;
const TAG_BITS_PER_SAMPLE:         u16 = 258;
const TAG_COMPRESSION:             u16 = 259;
const TAG_PHOTOMETRIC:             u16 = 262;
const TAG_STRIP_OFFSETS:           u16 = 273;
const TAG_SAMPLES_PER_PIXEL:       u16 = 277;
const TAG_ROWS_PER_STRIP:          u16 = 278;
const TAG_STRIP_BYTE_COUNTS:       u16 = 279;
const TAG_PLANAR_CONFIG:           u16 = 284;
const TAG_CFA_REPEAT_PATTERN_DIM:  u16 = 33421;
const TAG_CFA_PATTERN:             u16 = 33422;
const TAG_DNG_VERSION:             u16 = 50706;
const TAG_DNG_BACKWARD_VERSION:    u16 = 50707;
const TAG_UNIQUE_CAMERA_MODEL:     u16 = 50708;
const TAG_BLACK_LEVEL:             u16 = 50714;
const TAG_WHITE_LEVEL:             u16 = 50717;
const TAG_COLOR_MATRIX_1:          u16 = 50721;
const TAG_CAMERA_CALIBRATION_1:    u16 = 50723;
const TAG_ANALOG_BALANCE:          u16 = 50727;
const TAG_AS_SHOT_NEUTRAL:         u16 = 50728;
const TAG_BASELINE_EXPOSURE:       u16 = 50730;
const TAG_CALIBRATION_ILLUMINANT_1:u16 = 50778;

// CFA-photometric value
const PHOTOMETRIC_CFA: u16 = 32803;

// Illuminant code: 21 = D65 per EXIF spec.
const CALIBRATION_ILLUMINANT_D65: u16 = 21;

/// Synthesised Bayer DNG with a flat scene-linear neutral patch. See spec
/// `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.
#[derive(Clone, Debug)]
pub struct SyntheticGreyDng {
    /// Scene-linear neutral target after black subtract + WB. Range 0.0-1.0.
    pub linear_value: f32,
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub illuminant: Illuminant,
}

impl Default for SyntheticGreyDng {
    fn default() -> Self {
        Self {
            linear_value: 0.18,
            width: 64,
            height: 64,
            cfa: CfaPattern::Rggb,
            illuminant: Illuminant::D65,
        }
    }
}

impl SyntheticGreyDng {
    pub fn write_to(&self, path: &Path) -> io::Result<()> {
        std::fs::write(path, self.write_to_bytes())
    }

    pub fn write_to_bytes(&self) -> Vec<u8> {
        // Layout:
        //   [TIFF header 8 bytes]
        //   [IFD0 directory + overflow data]
        //   [pixel strip]
        //
        // We assemble the IFD into a temp buffer first to learn its size,
        // then write the header pointing at it. Pixel strip goes after.

        let header_size: u32 = 8;
        // Compute the IFD0 offset: directly after the header.
        let ifd0_offset = header_size;

        // Build the IFD0 directory. We need to know where the strip will
        // live so StripOffsets can point at it; we compute the IFD's full
        // serialised size first (including overflow), then place the strip
        // immediately after.
        //
        // To compute the IFD size before knowing strip offset, we serialise
        // it once with a placeholder, learn the size, then re-serialise
        // with the real strip offset.

        let strip_byte_count = (self.width as usize) * (self.height as usize) * 2;

        // First pass: build with a dummy strip offset to learn IFD size.
        let mut probe_ifd = self.build_ifd0(/*strip_offset*/ 0);
        let mut probe_buf = Vec::new();
        probe_ifd.serialise_into(&mut probe_buf, ifd0_offset);
        let ifd_size = probe_buf.len() as u32;

        // Real strip offset = after header + IFD.
        let strip_offset = ifd0_offset + ifd_size;

        // Second pass: real IFD with correct strip offset.
        let real_ifd = self.build_ifd0(strip_offset);
        let mut buf: Vec<u8> = Vec::with_capacity(
            (header_size as usize) + (ifd_size as usize) + strip_byte_count,
        );

        // Header
        buf.extend_from_slice(b"II");                  // little-endian
        write_u16_le(&mut buf, 0x002A);                // TIFF magic
        write_u32_le(&mut buf, ifd0_offset);

        // IFD0 directory + overflow
        real_ifd.serialise_into(&mut buf, ifd0_offset);

        // Pixel strip
        let strip = self.build_strip();
        buf.extend_from_slice(&strip);

        buf
    }

    fn build_ifd0(&self, strip_offset: u32) -> Ifd {
        let strip_byte_count = (self.width as u32) * (self.height as u32) * 2;

        let mut ifd = Ifd::new();
        ifd.add_long(TAG_NEW_SUBFILE_TYPE, 0);
        ifd.add_long(TAG_IMAGE_WIDTH, self.width);
        ifd.add_long(TAG_IMAGE_LENGTH, self.height);
        ifd.add_short(TAG_BITS_PER_SAMPLE, 16);
        ifd.add_short(TAG_COMPRESSION, 1);            // uncompressed
        ifd.add_short(TAG_PHOTOMETRIC, PHOTOMETRIC_CFA);
        ifd.add_long(TAG_STRIP_OFFSETS, strip_offset);
        ifd.add_short(TAG_SAMPLES_PER_PIXEL, 1);
        ifd.add_long(TAG_ROWS_PER_STRIP, self.height);
        ifd.add_long(TAG_STRIP_BYTE_COUNTS, strip_byte_count);
        ifd.add_short(TAG_PLANAR_CONFIG, 1);          // chunky

        // CFA: 2x2 pattern, RGGB bytes
        ifd.add_shorts(TAG_CFA_REPEAT_PATTERN_DIM, vec![2, 2]);
        ifd.add_bytes(TAG_CFA_PATTERN, self.cfa_pattern_bytes());

        // DNG identity
        ifd.add_bytes(TAG_DNG_VERSION,           vec![1, 4, 0, 0]);
        ifd.add_bytes(TAG_DNG_BACKWARD_VERSION,  vec![1, 0, 0, 0]);
        ifd.add_ascii(TAG_UNIQUE_CAMERA_MODEL,   "Maple Synthetic");

        // Linearisation
        ifd.add_short(TAG_BLACK_LEVEL, 0);
        ifd.add_short(TAG_WHITE_LEVEL, 65535);

        // Color: identity matrices, AsShotNeutral = (0.5, 1.0, 0.5)
        ifd.add_srationals(TAG_COLOR_MATRIX_1,
            vec![(1, 1), (0, 1), (0, 1),
                 (0, 1), (1, 1), (0, 1),
                 (0, 1), (0, 1), (1, 1)]);
        ifd.add_srationals(TAG_CAMERA_CALIBRATION_1,
            vec![(1, 1), (0, 1), (0, 1),
                 (0, 1), (1, 1), (0, 1),
                 (0, 1), (0, 1), (1, 1)]);
        ifd.add_rationals(TAG_ANALOG_BALANCE, vec![(1, 1), (1, 1), (1, 1)]);
        ifd.add_rationals(TAG_AS_SHOT_NEUTRAL,
            vec![(1, 2), (1, 1), (1, 2)]);   // 0.5, 1.0, 0.5
        ifd.add_srationals(TAG_BASELINE_EXPOSURE, vec![(0, 1)]);
        ifd.add_short(TAG_CALIBRATION_ILLUMINANT_1, CALIBRATION_ILLUMINANT_D65);

        ifd
    }

    fn build_strip(&self) -> Vec<u8> {
        let (raw_r, raw_g, raw_b) = compute_raw_values(
            self.linear_value, self.as_shot_neutral_array(), 0, 65535,
        );
        let n = (self.width as usize) * (self.height as usize);
        let mut buf = Vec::with_capacity(n * 2);
        // Walk row-major, emit 16-bit LE per CFA position.
        for y in 0..self.height {
            for x in 0..self.width {
                let v = match self.cfa.color_at(x, y) {
                    0 => raw_r,
                    1 => raw_g,
                    2 => raw_b,
                    _ => unreachable!(),
                };
                write_u16_le(&mut buf, v);
            }
        }
        buf
    }

    fn cfa_pattern_bytes(&self) -> Vec<u8> {
        // 4 bytes for 2x2 pattern, 0=R, 1=G, 2=B
        match self.cfa {
            CfaPattern::Rggb => vec![0, 1, 1, 2],
            CfaPattern::Bggr => vec![2, 1, 1, 0],
            CfaPattern::Grbg => vec![1, 0, 2, 1],
            CfaPattern::Gbrg => vec![1, 2, 0, 1],
            CfaPattern::LinearRgb => panic!(
                "SyntheticGreyDng with CfaPattern::LinearRgb is unsupported \
                 — synthesise a Bayer pattern (Rggb/Bggr/Grbg/Gbrg) instead"),
        }
    }

    fn as_shot_neutral_array(&self) -> [f32; 3] {
        // Fixed daylight balance baked into AsShotNeutral. Future variants
        // could vary this with `self.illuminant`.
        [0.5, 1.0, 0.5]
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::write_to_bytes 2>&1 | tail -10
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/test_support/synth_dng.rs
git commit -m "feat(raw-core): SyntheticGreyDng — full DNG byte writer"
```

---

## Task 6: Round-trip via raw-core decoder

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/synth_dng.rs`

The real correctness test for the writer is whether `decode::decode_bytes` can parse our output and recover the metadata we encoded. Failures here drive iterative fixes to the writer.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn round_trip_through_raw_core_decoder() {
        use crate::decode::decode_bytes;

        let dng = SyntheticGreyDng::default();
        let bytes = dng.write_to_bytes();

        let raw = decode_bytes(&bytes, "dng")
            .expect("synthetic DNG must decode via raw-core");

        assert_eq!(raw.width, 64);
        assert_eq!(raw.height, 64);
        assert_eq!(raw.cfa, CfaPattern::Rggb);
        assert_eq!(raw.white_level, 65535);
        // black_level is per-CFA-position; all four should be 0 since we
        // wrote a single BlackLevel = 0.
        assert!(raw.black_level.iter().all(|&b| b == 0),
            "expected black_level all zero, got {:?}", raw.black_level);
        // AsShotNeutral round-trips (small float tolerance for rational div).
        assert!((raw.as_shot_neutral[0] - 0.5).abs() < 1e-3);
        assert!((raw.as_shot_neutral[1] - 1.0).abs() < 1e-3);
        assert!((raw.as_shot_neutral[2] - 0.5).abs() < 1e-3);
        // Raw pixel buffer length matches w * h.
        assert_eq!(raw.raw_data.len(), (64 * 64) as usize);
        // Spot-check one R, G, B sample. RGGB at (0,0)=R, (1,0)=G, (1,1)=B.
        assert_eq!(raw.raw_data[0],         5898);   // (0,0) R
        assert_eq!(raw.raw_data[1],         11796);  // (1,0) G
        assert_eq!(raw.raw_data[64 + 1],    5898);   // (1,1) B
    }
```

- [ ] **Step 2: Run the test**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::round_trip 2>&1 | tail -30
```

Expected outcome is *unknown until we run it.* Two paths:

- **PASS first try.** Lucky — proceed to Step 5.
- **FAIL.** Read the assertion / panic / decoder error, iterate on the writer (most likely culprits: missing required tag, wrong tag type, wrong CFA byte order, strip layout). The decoder is the source of truth for what's required. Diagnose by adding a `dbg!(&raw)` and rerunning.

- [ ] **Step 3: Iterate on the writer until the test passes**

If the decoder errors with "missing tag X", add it. If it complains about a type mismatch, fix the type. If `raw_data` has wrong values, check the strip layout and CFA byte ordering. Each fix is a small edit + rerun loop on the same single test.

- [ ] **Step 4: Verify**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::synth_dng::tests::round_trip 2>&1 | tail -10
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/src/test_support/synth_dng.rs
git commit -m "test(raw-core): synthetic DNG round-trips through decode_bytes"
```

---

## Task 7: `run_scene_linear_case` harness (TDD)

**Files:**
- Create: `src/raw-pipeline/raw-core/tests/grey_invariants.rs`

Move from unit tests to integration tests. This file lives in `raw-core/tests/` so it links against `raw-core` as an external crate — same as `maple-cli`.

- [ ] **Step 1: Write the failing test**

Create `src/raw-pipeline/raw-core/tests/grey_invariants.rs`:

```rust
//! Pipeline neutrality + flatness invariants on synthetic grey DNGs.
//! See `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Render a synthetic grey DNG to scene-linear and assert per-pixel
/// neutrality + spatial flatness.
fn run_scene_linear_case(linear_value: f32, eps_color: f32, eps_flat: f32) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let model = AdjustmentModel::default();
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    // Invariant A: per-pixel R == G == B within eps_color.
    for (i, p) in scene.pixels.iter().enumerate() {
        let (r, g, b) = (p[0], p[1], p[2]);
        assert!((r - g).abs() <= eps_color,
            "pixel {}: |R-G| = {} > {} (R={} G={} B={})", i, (r-g).abs(), eps_color, r, g, b);
        assert!((r - b).abs() <= eps_color,
            "pixel {}: |R-B| = {} > {} (R={} G={} B={})", i, (r-b).abs(), eps_color, r, g, b);
    }

    // Invariant B: per-pixel value == image mean within eps_flat (per channel).
    let n = scene.pixels.len() as f32;
    let mean_r: f32 = scene.pixels.iter().map(|p| p[0]).sum::<f32>() / n;
    let mean_g: f32 = scene.pixels.iter().map(|p| p[1]).sum::<f32>() / n;
    let mean_b: f32 = scene.pixels.iter().map(|p| p[2]).sum::<f32>() / n;
    for (i, p) in scene.pixels.iter().enumerate() {
        assert!((p[0] - mean_r).abs() <= eps_flat,
            "pixel {} R={} deviates from mean R={} by > {}", i, p[0], mean_r, eps_flat);
        assert!((p[1] - mean_g).abs() <= eps_flat,
            "pixel {} G={} deviates from mean G={} by > {}", i, p[1], mean_g, eps_flat);
        assert!((p[2] - mean_b).abs() <= eps_flat,
            "pixel {} B={} deviates from mean B={} by > {}", i, p[2], mean_b, eps_flat);
    }
}

#[test]
fn neutral_scene_linear_018() {
    run_scene_linear_case(0.18, 1e-5, 1e-5);
}
```

- [ ] **Step 2: Run the test**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --test grey_invariants neutral_scene_linear_018 2>&1 | tail -30
```

Expected outcome unknown — there are two realistic ways this can fail:

- **Edge effects from demosaic.** The corner pixels of a 64×64 patch may differ from the interior because the demosaic kernel reads outside the image. If so, tighten the test domain to interior pixels (skip 2 px border) — but first, see whether the failure pattern matches that hypothesis.
- **Tolerance too tight.** Float accumulation in WB / DCP can be more than 1e-5 off. If so, loosen to `1e-4` and document.

- [ ] **Step 3: Iterate on tolerance / domain until passing**

If the failure is edge-only, modify `run_scene_linear_case` to skip the outer 2 pixels:

```rust
let stride = scene.width as usize;
let interior: Vec<&[f32; 3]> = scene.pixels.iter().enumerate()
    .filter(|(i, _)| {
        let x = i % stride; let y = i / stride;
        x >= 2 && x < scene.width as usize - 2 &&
        y >= 2 && y < scene.height as usize - 2
    })
    .map(|(_, p)| p)
    .collect();
// then run invariants on `interior` instead of `scene.pixels`.
```

If the failure is everywhere, raise `eps_color` / `eps_flat` to whatever value passes, then ratchet down in a follow-up (consistent with `BUDGET` convention).

- [ ] **Step 4: Verify**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --test grey_invariants neutral_scene_linear_018 2>&1 | tail -10
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/raw-pipeline/raw-core/tests/grey_invariants.rs
git commit -m "test(raw-core): scene-linear neutrality + flatness invariants on synthetic grey"
```

---

## Task 8: `run_display_case` harness (TDD)

**Files:**
- Modify: `src/raw-pipeline/raw-core/tests/grey_invariants.rs`

Same shape as Task 7, but exercises the production view tail (AgX → sRGB → u8) and asserts in 8-bit LSB.

- [ ] **Step 1: Write the failing test**

Append to `src/raw-pipeline/raw-core/tests/grey_invariants.rs`:

```rust
use raw_core::pipeline::render_from_raw;

/// Render a synthetic grey DNG through the full production pipeline
/// (AgX + sRGB + u8 quantize) and assert per-pixel neutrality + flatness
/// in 8-bit LSB.
fn run_display_case(linear_value: f32, eps_color: i32, eps_flat: i32) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let model = AdjustmentModel::default();
    let (w, h, rgb) = render_from_raw(&raw, &model)
        .expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    assert_eq!(rgb.len(), n * 3);

    // Invariant A: per-pixel R == G == B in 8-bit LSB.
    for i in 0..n {
        let r = rgb[i*3]     as i32;
        let g = rgb[i*3 + 1] as i32;
        let b = rgb[i*3 + 2] as i32;
        assert!((r - g).abs() <= eps_color,
            "pixel {}: |R-G| = {} > {} (R={} G={} B={})", i, (r-g).abs(), eps_color, r, g, b);
        assert!((r - b).abs() <= eps_color,
            "pixel {}: |R-B| = {} > {} (R={} G={} B={})", i, (r-b).abs(), eps_color, r, g, b);
    }

    // Invariant B: per-channel flatness in 8-bit LSB.
    let mean = |chan: usize| -> i32 {
        let s: i32 = (0..n).map(|i| rgb[i*3 + chan] as i32).sum();
        (s + n as i32 / 2) / n as i32  // round-half-up
    };
    let (mr, mg, mb) = (mean(0), mean(1), mean(2));
    for i in 0..n {
        assert!((rgb[i*3]     as i32 - mr).abs() <= eps_flat,
            "pixel {} R={} deviates from mean {} by > {}", i, rgb[i*3], mr, eps_flat);
        assert!((rgb[i*3 + 1] as i32 - mg).abs() <= eps_flat,
            "pixel {} G={} deviates from mean {} by > {}", i, rgb[i*3 + 1], mg, eps_flat);
        assert!((rgb[i*3 + 2] as i32 - mb).abs() <= eps_flat,
            "pixel {} B={} deviates from mean {} by > {}", i, rgb[i*3 + 2], mb, eps_flat);
    }
}

#[test]
fn neutral_display_srgb_018() {
    run_display_case(0.18, 2, 2);
}
```

- [ ] **Step 2: Run the test**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --test grey_invariants neutral_display_srgb_018 2>&1 | tail -30
```

Expected outcome unknown. Same iteration loop as Task 7 — if it fails, isolate whether the bug is at scene-linear (already covered by Task 7) or specifically in the view tail. If view-tail-only and the failure is small / consistent, raise `eps_color` and `eps_flat` to whatever value passes, document, ratchet down later.

- [ ] **Step 3: Iterate as needed, then verify**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support \
    --test grey_invariants neutral_display_srgb_018 2>&1 | tail -10
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add src/raw-pipeline/raw-core/tests/grey_invariants.rs
git commit -m "test(raw-core): display-encoded sRGB neutrality + flatness on synthetic grey"
```

---

## Task 9: Sweep tests across L ∈ {0.05, 0.18, 0.50}

**Files:**
- Modify: `src/raw-pipeline/raw-core/tests/grey_invariants.rs`

Multiplicative coverage: 3 levels × 2 checkpoints = 6 test cases.

- [ ] **Step 1: Add the sweep tests**

Append to `src/raw-pipeline/raw-core/tests/grey_invariants.rs`:

```rust
#[test] fn neutral_scene_linear_005() { run_scene_linear_case(0.05, 1e-5, 1e-5); }
#[test] fn neutral_scene_linear_050() { run_scene_linear_case(0.50, 1e-5, 1e-5); }

#[test] fn neutral_display_srgb_005() { run_display_case(0.05, 2, 2); }
#[test] fn neutral_display_srgb_050() { run_display_case(0.50, 2, 2); }
```

- [ ] **Step 2: Run the full file**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support --test grey_invariants 2>&1 | tail -15
```

Expected: 6 passed (the 4 new + 2 from Tasks 7 and 8). If a sweep case fails with the same tolerance that 0.18 passes, it's signal that L matters — investigate before just bumping the budget.

- [ ] **Step 3: Commit**

```bash
git add src/raw-pipeline/raw-core/tests/grey_invariants.rs
git commit -m "test(raw-core): sweep neutrality invariants across L ∈ {0.05, 0.18, 0.50}"
```

---

## Task 10: CLI example `synth-grey.rs`

**Files:**
- Create: `src/raw-pipeline/raw-core/examples/synth-grey.rs`

A standalone binary that wraps `SyntheticGreyDng` for ad-hoc generation. Useful for piping a known-good grey through the Apple xcframework or WASM build during cross-platform parity work.

`clap` is available at `src/raw-pipeline/Cargo.toml:16` as `clap = { version = "4", features = ["derive"] }` in `[workspace.dependencies]`.

- [ ] **Step 1: Add `clap` as a dev-dep on raw-core**

Update `src/raw-pipeline/raw-core/Cargo.toml`'s `[dev-dependencies]` section:

```toml
[dev-dependencies]
serde.workspace = true
serde_json.workspace = true
tempfile = "3"
clap = { workspace = true }
```

(The `features = ["derive"]` is already declared at the workspace level, so we inherit it.)

- [ ] **Step 2: Create the example**

Create `src/raw-pipeline/raw-core/examples/synth-grey.rs`:

```rust
//! Generate a synthetic grey DNG. See
//! `.archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md`.
//!
//! Build:
//!   cargo build --release -p raw-core --features test-support \
//!       --example synth-grey
//!
//! Run:
//!   cargo run --release -p raw-core --features test-support \
//!       --example synth-grey -- --value 0.18 --out /tmp/grey.dng

use clap::Parser;
use raw_core::image::CfaPattern;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Synthesise a flat-grey Bayer DNG for pipeline neutrality tests")]
struct Args {
    /// Scene-linear neutral target after black + WB. Range 0.0-1.0.
    #[arg(long, default_value_t = 0.18)]
    value: f32,
    /// Image width in pixels (default 64).
    #[arg(long, default_value_t = 64)]
    width: u32,
    /// Image height in pixels (default 64).
    #[arg(long, default_value_t = 64)]
    height: u32,
    /// CFA pattern: rggb | bggr | grbg | gbrg.
    #[arg(long, default_value = "rggb")]
    cfa: String,
    /// Output DNG path.
    #[arg(long)]
    out: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let cfa = match args.cfa.to_lowercase().as_str() {
        "rggb" => CfaPattern::Rggb,
        "bggr" => CfaPattern::Bggr,
        "grbg" => CfaPattern::Grbg,
        "gbrg" => CfaPattern::Gbrg,
        other  => return Err(format!("unknown cfa '{}': use rggb|bggr|grbg|gbrg", other).into()),
    };
    let dng = SyntheticGreyDng {
        linear_value: args.value,
        width: args.width,
        height: args.height,
        cfa,
        ..Default::default()
    };
    dng.write_to(&args.out)?;
    eprintln!("wrote {} ({}x{}, L={})", args.out.display(), args.width, args.height, args.value);
    Ok(())
}
```

- [ ] **Step 3: Build the example**

```bash
cd src/raw-pipeline
cargo build --release -p raw-core --features test-support --example synth-grey 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 4: Smoke-test the example end-to-end**

```bash
cd src/raw-pipeline
cargo run --release -p raw-core --features test-support --example synth-grey -- \
    --value 0.18 --out /tmp/synth-grey.dng
cargo run --release --bin maple-cli -- inspect /tmp/synth-grey.dng
```

Expected: `inspect` prints `dimensions: 64 × 64`, `CFA: Rggb`, `white: 65535`, `black: [0, 0, 0, 0]`, `as-shot WB: [0.5, 1.0, 0.5]`.

- [ ] **Step 5: Render the synthetic DNG and visually confirm grey**

```bash
cd src/raw-pipeline
cargo run --release --bin maple-cli -- render /tmp/synth-grey.dng --out /tmp/synth-grey.png
```

Open `/tmp/synth-grey.png`. Expected: a uniform grey patch. Sanity check only — the unit tests are the real gate.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/Cargo.toml \
        src/raw-pipeline/raw-core/examples/synth-grey.rs
git commit -m "feat(raw-core): synth-grey example for ad-hoc DNG generation"
```

---

## Task 11: CI gate `test_synthetic_grey.sh`

**Files:**
- Create: `src/scripts/test_synthetic_grey.sh`

- [ ] **Step 1: Create the script**

Create `src/scripts/test_synthetic_grey.sh`:

```bash
#!/usr/bin/env bash
# Synthetic grey neutrality + flatness gate.
#
# Sibling of test_color_pipeline.sh. Unlike that harness, inputs are
# synthesised in-memory — no test-fixtures/raws/ needed — so this script
# never skip-passes. Always runs, always asserts. The strictest pipeline
# regression net we have.
#
# Spec: .archived-plans/specs/2026-04-28-synthetic-grey-dng-design.md

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_invariants -- --nocapture
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/riabuz/Projects/_Maple/src/scripts/test_synthetic_grey.sh
```

- [ ] **Step 3: Run end-to-end**

```bash
cd /Users/riabuz/Projects/_Maple
./src/scripts/test_synthetic_grey.sh 2>&1 | tail -20
```

Expected: 6 tests pass, exit 0. Wall-clock under 2 seconds.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/test_synthetic_grey.sh
git commit -m "feat(scripts): test_synthetic_grey.sh — pipeline neutrality CI gate"
```

---

## Final verification

- [ ] **Step 1: Full clean build with feature flag**

```bash
cd src/raw-pipeline
cargo build -p raw-core --features test-support 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 2: Full clean build WITHOUT feature flag (shipping config)**

```bash
cd src/raw-pipeline
cargo build -p raw-core 2>&1 | tail -5
```

Expected: clean. Confirms `test_support` is properly gated and won't ship in the xcframework or WASM.

- [ ] **Step 3: Run the new gate**

```bash
cd /Users/riabuz/Projects/_Maple
./src/scripts/test_synthetic_grey.sh 2>&1 | tail -20
```

Expected: 6 passed, 0 failed, 0 skipped. Exit 0.

- [ ] **Step 4: Run the existing color-pipeline harness to confirm we didn't break anything**

```bash
cd /Users/riabuz/Projects/_Maple
./src/scripts/test_color_pipeline.sh 2>&1 | tail -10
```

Expected: same result as before this plan started (PASS or skip-pass with "no fixtures").

- [ ] **Step 5: Run the rest of the raw-core test suite**

```bash
cd src/raw-pipeline
cargo test -p raw-core --features test-support 2>&1 | tail -10
```

Expected: all existing tests still pass, plus the 6 new ones.

---

## Acceptance criteria (from spec)

- [x] (planned) `src/scripts/test_synthetic_grey.sh` exits 0 on `main` with all 6 cases passing — Tasks 9, 11
- [x] (planned) Generator round-trips through Maple's existing DNG decoder — Task 6
- [x] (planned) `cargo run --example synth-grey` produces a renderable DNG — Task 10
- [x] (planned) New test gate runs in <2 seconds wall-clock locally — Task 11 Step 3 verifies
