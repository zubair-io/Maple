# Export recipe metadata and ICC fixtures

These are fixed ICC v2 matrix/TRC profiles emitted by Maple's shared export
encoder. They pin the byte-level output contract for all six
JPEG8/TIFF16/PNG8 × sRGB/Display P3 recipe combinations. The test reads these
committed bytes directly; it does not derive its expected profile by calling
`icc::profile_for` again.

Regenerated 2026-09-12 for #3577: the `rTRC`/`gTRC`/`bTRC` `curv` table
tabulated the encode direction (OETF, linear → device) instead of the decode
direction a CMM actually reads (EOTF, device → linear) a matrix/TRC curve
tag as. Byte counts are unchanged (only the 1024 curve entries' values
differ), so only the SHA-256 below moved.

| Fixture                   | Bytes | SHA-256                                                            |
| ------------------------- | ----: | ------------------------------------------------------------------ |
| `maple-srgb-v2.icc`       |  6684 | `b4a6a126da808e600a4cb91d51f4c7f98ec9b4e52da29ca39bb84bf932980e1b` |
| `maple-display-p3-v2.icc` |  6688 | `190f5590aeef2d0b903ceaef8dc25c73c5b20602846a4cc2916dc7a2cdb15e34` |

The sRGB bytes were extracted from the actual Hosted production browser recipe
export (`maple2438-browser-export.jpg`). The Display P3 bytes were extracted from
the native shared-encoder recipe export (`maple2438-golden-p3.jpg`). Both source
images were generated from the synthetic Bayer DNG used for export qualification;
the temporary JPEGs are not required by tests. Pillow's JPEG reader extracted the
ICC payload, and its LittleCMS binding independently opened each as `Maple sRGB`
or `Maple Display P3`. These are Maple-generated profiles, not third-party assets.
The canonical colorant/TRC semantics remain covered by `raw-core/src/icc.rs` tests.
An intentional profile change requires review of these binary golden changes.

`raw-core/src/export_recipe/metadata_fixture.rs` appends real EXIF capture time,
ISO, GPS coordinates, Artist and XMP to a 64×48 synthetic DNG. Before exporting,
the regression verifies the metadata through the source parsers. Each output
must retain its ICC golden while omitting EXIF/GPS/XMP, TIFF source tags, JPEG
metadata segments and PNG text carriers. The source bytes must remain unchanged.

Run `cargo test -p raw-core export_recipe --lib` from `src/raw-pipeline`.
These fixtures establish encoding and metadata policy, not physical-camera color
quality, lens coverage or large-image performance.
