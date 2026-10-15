`portrait.dng` is a copy of the committed `batch-transfer/source.dng` with EXIF
Orientation set to 6 (90° clockwise). It exercises orientation-aware portrait
layout through the real RAW decoder and GPU presenter. The source is unchanged.

Regenerate from the repository root:

```sh
cp test-fixtures/batch-transfer/source.dng test-fixtures/android/portrait.dng
exiftool -overwrite_original -Orientation#=6 test-fixtures/android/portrait.dng
```

`wide-p3.avif` is a synthetic 32×16, 10-bit AVIF with saturated Display P3
red, green and blue bands plus a neutral band. The existing ICC validation
fixture contains only in-sRGB colors; this fixture exercises negative and
above-one channels if converted to sRGB. The device test retains its original
P3 gamut and checks exact channel transport plus ICC colorants and transfer curves.
It is encoded by the actual shared-core AVIF encoder at quality 100, effort 1,
with the shared Display P3 ICC profile. It is a lossy encode; the device test
compares the actual OS-decoded values exactly against the float TIFF transport.

Regenerate from the repository root:

```sh
cargo run --locked --manifest-path src/android/native/Cargo.toml --example generate_color_fixture
```

SHA-256: `f9d2478df21b9265de7b07f3259b963b3d61fc45b27400ce64c581d48ba852f8`.

`large-48mp.heic` is a genuine 8000×6000 Display P3 HEIF with a flat RGB
field, encoded by macOS ImageIO at quality 0.8. Its small compressed size keeps
the fixture portable; the full RGBA bitmap would require at least 192 MB before
float TIFF staging. The Android test checks that 512- and 2048-pixel staging stay
bounded and do not create a full-resolution TIFF during live-preview requests.
The existing small 10-bit AVIF fixtures separately gate precision and gamut.
This is a decoder/allocation regression, not a color reference or hardware
qualification. An untiled 8000×6000 AVIF was rejected at codec configuration by
the API 36 emulator (its AV1 component caps dimensions at 4096); this HEIF uses
ImageIO's image grid and exercises the real high-resolution phone-image path.

Regenerate on macOS from the repository root:

```sh
swift src/android/scripts/generate-large-heif.swift test-fixtures/android/large-48mp.heic
```

SHA-256: `5c83a43378e24fc74fec47c308be80326727e0cd1f8549b237d698c1b2800826`.
