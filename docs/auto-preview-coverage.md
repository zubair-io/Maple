# Auto Profile preview coverage

Auto Profile fits colour and contrast against the camera's own embedded JPEG preview. This page records which preview each camera gives it, what happens when there is none, and how to re-run the audit on any folder of RAWs (#5458).

## How it works

1. When a RAW opens with the Auto profile, the core looks for an embedded preview in a fixed order and stops at the first one that decodes:
   1. the RAW's preview image;
   2. its full-size embedded image;
   3. the DNG thumbnail (DNG only);
   4. a raw byte scan for a JPEG (non-TIFF containers only).

   On the server, `exiftool` is the last resort. It is not available in the Apple sandbox or in the browser.

2. If a preview is found, Auto fits against it. If not, the photo renders exactly as Neutral.
3. The core reports which of three outcomes happened:
   - Auto applied.
   - No camera preview.
   - Auto not fitted for another reason, such as a degenerate fit or a file that could not be read.

   Every client reads that outcome. None of them guess from the file type.

4. When Auto is selected and the outcome is "no camera preview", the profile picker shows **"Auto unavailable: no camera preview — showing Neutral."** The text is also exposed to screen readers. This applies on Apple (macOS and iOS), Web, Windows and Linux.

## Running the audit

```bash
cd src/raw-pipeline
cargo run --release --bin maple-cli -- preview-coverage <RAW or folder>...   # Markdown tables
cargo run --release --bin maple-cli -- preview-coverage --json <folder>      # One JSON record per RAW
```

**What it reads.** Folders are walked recursively. Directory symlinks are not followed, and only extensions the RAW decoder supports are read. A file that can't be opened prints `skipped …` to stderr and is left out. The command still exits 0. Nothing is written next to the photos.

**JSON output.** Each record contains:

- the file;
- make, model and format;
- the RAW size and the colour space;
- each source's size, using the same source names as the Markdown;
- the server and sandbox winners;
- the flags.

**Markdown columns:**

- **Sensor** is the RAW's display-oriented crop size, which is what a full render produces. Some bodies record a crop smaller than their embedded preview, so a ratio can be above 1.00 (`test_0010`).
- **Winner (server)** is the source the server picks, with `exiftool` allowed. **Winner (sandbox/WASM)** is what Apple and the browser pick without it.
- Each size is followed by its long edge as a fraction of the Sensor long edge.
- **Other sources** lists every other source that also yields an image.
- **Flags** are computed against the server winner. A winner is flagged when an alternative's long edge is at least 1.5× larger, or when the winner's long edge is below a quarter of the Sensor long edge.

## Results: the 20 colour fixtures

The audit covers the 20 colour fixtures in `test-fixtures/raws/`: `test_0000` to `test_0020`, minus the excluded `test_0016` X3F. That scope is the owner's decision. No library sample or production data was read.

| File          | Camera                | Format | Sensor     | Colour space | Winner (server)                | Winner (sandbox/WASM)          | Other sources                                          | Flags              |
| ------------- | --------------------- | ------ | ---------- | ------------ | ------------------------------ | ------------------------------ | ------------------------------------------------------ | ------------------ |
| test_0000.DNG | Hasselblad L3D-100c   | DNG    | 12288×8192 | sRGB         | full_image 960×640 (0.08)      | full_image 960×640 (0.08)      | dng_thumbnail 180×120 (0.01); exiftool 960×640 (0.08)  | below sensor floor |
| test_0001.RAW | Panasonic DMC-LX2     | RW2    | 4224×2376  | sRGB         | none                           | none                           | —                                                      |                    |
| test_0002.dng | Hasselblad H2D-39     | DNG    | 7216×5412  | sRGB         | dng_thumbnail 721×541 (0.10)   | dng_thumbnail 721×541 (0.10)   | —                                                      | below sensor floor |
| test_0003.CR2 | Canon EOS 5DS R       | CR2    | 5792×8688  | Adobe RGB    | full_image 8688×5792 (1.00)    | full_image 8688×5792 (1.00)    | exiftool 8688×5792 (1.00)                              |                    |
| test_0004.fff | Hasselblad H5D-40     | TFR    | 7304×5478  | sRGB         | full_image 1217×913 (0.17)     | full_image 1217×913 (0.17)     | —                                                      | below sensor floor |
| test_0005.RAF | Fujifilm GFX 50S      | RAF    | 8256×6192  | Adobe RGB    | full_image 4000×3000 (0.48)    | full_image 4000×3000 (0.48)    | jpeg_scan 4000×3000 (0.48); exiftool 4000×3000 (0.48)  |                    |
| test_0006.DNG | Canon EOS 5D Mark III | DNG    | 5760×3840  | sRGB         | full_image 1024×683 (0.18)     | full_image 1024×683 (0.18)     | dng_thumbnail 256×171 (0.04); exiftool 1024×683 (0.18) | below sensor floor |
| test_0007.DNG | Canon EOS 5D Mark III | DNG    | 5760×3840  | sRGB         | full_image 1024×683 (0.18)     | full_image 1024×683 (0.18)     | dng_thumbnail 256×171 (0.04); exiftool 1024×683 (0.18) | below sensor floor |
| test_0008.RAF | Fujifilm X-T3         | RAF    | 6240×4160  | sRGB         | full_image 4416×2944 (0.71)    | full_image 4416×2944 (0.71)    | jpeg_scan 4416×2944 (0.71); exiftool 4416×2944 (0.71)  |                    |
| test_0009.CR2 | Canon EOS 5D Mark IV  | CR2    | 6720×4480  | sRGB         | full_image 6720×4480 (1.00)    | full_image 6720×4480 (1.00)    | exiftool 6720×4480 (1.00)                              |                    |
| test_0010.CR2 | Canon EOS 5D Mark IV  | CR2    | 5040×3360  | sRGB         | full_image 6720×4480 (1.33)    | full_image 6720×4480 (1.33)    | exiftool 6720×4480 (1.33)                              |                    |
| test_0011.ARW | Sony ILCE-7RM4        | ARW    | 9504×6336  | sRGB         | full_image 1616×1080 (0.17)    | full_image 1616×1080 (0.17)    | exiftool 1616×1080 (0.17)                              | below sensor floor |
| test_0012.raf | Fujifilm GFX 50R      | RAF    | 8256×6192  | sRGB         | full_image 4000×3000 (0.48)    | full_image 4000×3000 (0.48)    | jpeg_scan 4000×3000 (0.48); exiftool 4000×3000 (0.48)  |                    |
| test_0013.DNG | Apple iPhone 12 Pro   | DNG    | 3024×4032  | sRGB         | dng_thumbnail 4032×3024 (1.00) | dng_thumbnail 4032×3024 (1.00) | exiftool 4032×3024 (1.00)                              |                    |
| test_0014.NEF | Nikon D850            | NEF    | 8256×5504  | sRGB         | full_image 8256×5504 (1.00)    | full_image 8256×5504 (1.00)    | exiftool 640×424 (0.08)                                |                    |
| test_0015.dng | Google Pixel 6 Pro    | DNG    | 4064×3056  | sRGB         | dng_thumbnail 680×512 (0.17)   | dng_thumbnail 680×512 (0.17)   | exiftool 680×512 (0.17)                                | below sensor floor |
| test_0017.dng | Leica M10             | DNG    | 5976×3984  | sRGB         | full_image 5952×3968 (1.00)    | full_image 5952×3968 (1.00)    | exiftool 1440×960 (0.24)                               |                    |
| test_0018.dng | (no camera metadata)  | DNG    | 848×560    | sRGB         | none                           | none                           | —                                                      |                    |
| test_0019.dng | (no camera metadata)  | DNG    | 848×560    | sRGB         | none                           | none                           | —                                                      |                    |
| test_0020.dng | (no camera metadata)  | DNG    | 3584×2688  | sRGB         | none                           | none                           | —                                                      |                    |

| Camera                | RAWs | No preview (server) | No preview (sandbox/WASM) | Suspect winner |
| --------------------- | ---- | ------------------- | ------------------------- | -------------- |
| (no camera metadata)  | 3    | 3                   | 3                         | 0              |
| Apple iPhone 12 Pro   | 1    | 0                   | 0                         | 0              |
| Canon EOS 5D Mark III | 2    | 0                   | 0                         | 2              |
| Canon EOS 5D Mark IV  | 2    | 0                   | 0                         | 0              |
| Canon EOS 5DS R       | 1    | 0                   | 0                         | 0              |
| Fujifilm GFX 50R      | 1    | 0                   | 0                         | 0              |
| Fujifilm GFX 50S      | 1    | 0                   | 0                         | 0              |
| Fujifilm X-T3         | 1    | 0                   | 0                         | 0              |
| Google Pixel 6 Pro    | 1    | 0                   | 0                         | 1              |
| Hasselblad H2D-39     | 1    | 0                   | 0                         | 1              |
| Hasselblad H5D-40     | 1    | 0                   | 0                         | 1              |
| Hasselblad L3D-100c   | 1    | 0                   | 0                         | 1              |
| Leica M10             | 1    | 0                   | 0                         | 0              |
| Nikon D850            | 1    | 0                   | 0                         | 0              |
| Panasonic DMC-LX2     | 1    | 1                   | 1                         | 0              |
| Sony ILCE-7RM4        | 1    | 0                   | 0                         | 1              |
| **All**               | 20   | 4                   | 4                         | 7              |

### Headline

- **4 of 20 have no preview**, both on the server and in the sandbox:
  - the Panasonic DMC-LX2 RW2 (`test_0001`), a real camera;
  - the three metadata-less synthetic DNGs (`test_0018` to `test_0020`).

  These are the files that now show the "Auto unavailable" status.

- **`exiftool` never rescues a file.** Wherever it finds a preview, the in-process sources had already found one the same size or larger. Examples:
  - Nikon D850: `exiftool` finds 640×424, against an 8256×5504 full image.
  - Leica M10: 1440×960, against 5952×3968.

  So sandbox coverage equals server coverage.

- **No winner is smaller than an available alternative.** Taking the first source that decodes already picks the largest image on every fixture.
- **7 winners are below a quarter of the Sensor long edge, but each one is the only source available or the largest:**
  - Hasselblad L3D-100c: 960×640 (8% of its 12288 px edge)
  - Hasselblad H2D-39: 721×541 DNG thumbnail
  - Hasselblad H5D-40: 1217×913
  - Canon 5D Mark III (two DNGs): 1024×683
  - Sony A7R IV: 1616×1080
  - Pixel 6 Pro: 680×512

## Decision: no change to preview selection

Switching to "largest suitable source, with a floor relative to sensor size" would change nothing on these fixtures, because the largest source already wins everywhere.

The only effect a sensor floor could have is to turn Auto off for the 7 small-preview cameras and render them as Neutral. That contradicts Auto being the default by design (see the load-bearing principles in `CLAUDE.md`). The fit also already works from a downsampled 1536 px proxy (#3510).

So selection is unchanged, and no colour budgets or references move. The small-preview cameras are listed above for the owner. Re-run the audit on a library before revisiting this decision.
