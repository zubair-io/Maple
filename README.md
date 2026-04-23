# Maple

A professional, non-destructive photo editor for macOS, iPadOS, and iOS. All edits are non-destructive and persist to XMP sidecars — originals are never modified. The same edit model roams across Mac, iPad, and iPhone, and the same RAW pipeline drives both the native apps and the web editor.

## maple-cli — reference renderer

The Rust raw-pipeline ships with a CLI for rendering, batch processing, comparing outputs, and inspecting metadata. Useful for testing the pipeline outside the apps.

### Build

```sh
cargo build --release --manifest-path src/raw-pipeline/Cargo.toml -p maple-cli
```

The binary lands at `src/raw-pipeline/target/release/maple-cli`.

### Subcommands

```sh
maple-cli render   --out OUT.png    [--params SIDECAR.xmp] [--format png|jpeg|tiff] [--quality 1..100] RAW
maple-cli batch    --out-dir OUT/   [--cases test_0002_baseline,...] MANIFEST.json
maple-cli diff     --budget MEAN_DE CANDIDATE.png REFERENCE.png
maple-cli inspect  PATH              # RAW or .xmp
```

### Examples

```sh
# Render a CR2 with default adjustments to PNG
src/raw-pipeline/target/release/maple-cli render \
  --out /tmp/out.png \
  test-fixtures/raws/test_0003.CR2

# Render a DNG with an XMP sidecar to JPEG at quality 95
src/raw-pipeline/target/release/maple-cli render \
  --out /tmp/out.jpg --quality 95 \
  --params test-fixtures/references/test_0002/xmp/dehaze_max.xmp \
  test-fixtures/raws/test_0002.dng

# Inspect a RAW's metadata (camera, AsShotNeutral, color matrices, etc.)
src/raw-pipeline/target/release/maple-cli inspect test-fixtures/raws/test_0000.DNG

# Compare two PNGs (runs src/scripts/compare_images.py for ΔE 2000)
src/raw-pipeline/target/release/maple-cli diff /tmp/out.png reference.png --budget 5
```

### Golden tests

The full reference test suite (renders fixtures + compares against ACR references via Python):

```sh
cargo test --manifest-path src/raw-pipeline/Cargo.toml -p raw-core \
  --features golden --test golden -- --nocapture --test-threads=4
```

Outputs land in `target/golden-out/`. Requires Python 3 with `Pillow`, `numpy`, `colour-science` (see `src/scripts/requirements.txt`).
