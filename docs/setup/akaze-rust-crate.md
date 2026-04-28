# Rust AKAZE crate

**Crate:** `akaze = "0.7"` — published by the rust-cv organisation (MIT license).  
**Dep added at:** `src/raw-pipeline/pano-core/Cargo.toml`  
**Workspace patch:** `src/raw-pipeline/vendor/bitarray/` (see below)

## Rationale

`akaze 0.7` is the only published Rust crate that implements AKAZE end-to-end — both the non-linear scale space detector and the M-LDB binary descriptor — in a single, dependency-light package. The kornia ecosystem does not yet expose AKAZE; the `cv` umbrella crate re-exports the same `akaze` crate. The crate is MIT-licensed, and its public API (`Akaze::extract(&self, image: &DynamicImage) -> (Vec<KeyPoint>, Vec<BitArray<64>>)`) is stable enough for our wrapper: `AkazeDetector` will convert a `PanoImage` to an `image::DynamicImage`, call `Akaze::extract`, and repack the results into `Features { keypoints, descriptors, descriptor_dim }`. AKAZE descriptors are 512-bit binary arrays, so `descriptor_dim = 64` (bytes).

**Stable-Rust patch:** the published `bitarray 0.2.6` (a transitive dependency of `akaze`) carries `#![feature(min_const_generics)]`, which became stable in Rust 1.51 and is now rejected by the stable channel (E0554). `src/raw-pipeline/vendor/bitarray/` is a verbatim copy of `bitarray 0.2.6` with that single attribute removed; the workspace-level `[patch.crates-io]` in `src/raw-pipeline/Cargo.toml` redirects Cargo to the local copy. No API surface changes.

## API surface used in Task 1.2

```rust
use akaze::{Akaze, KeyPoint};
// detector construction
let akaze = Akaze::default();   // or Akaze { threshold: 0.001, .. }
// detection + description
let (keypoints, descriptors): (Vec<KeyPoint>, Vec<BitArray<64>>) =
    akaze.extract(&dynamic_image);
// KeyPoint fields: point.0 (x: f32), point.1 (y: f32), response, octave, class_id, angle, size
// BitArray<64> Deref<Target=[u8;64]> — 64 bytes = 512-bit M-LDB descriptor
```

## Platform restrictions

`akaze 0.7` is a pure-Rust + CPU-only crate; it compiles on all platforms including `wasm32-unknown-unknown`. It does not link any C/C++ library.
