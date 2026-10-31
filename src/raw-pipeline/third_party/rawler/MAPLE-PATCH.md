# Rawler 0.7.2 metadata source patch (#5163)

The source matches the previously vendored rawler 0.7.2, except `src/rawsource.rs` and the documented dummy-decode payload guards.
The crate moved from `vendor/` to `third_party/` as required for path patches.
`RawSource` now carries a source lifetime and adds a borrowed-slice constructor.
A separate metadata file constructor omits whole-file population and prefetch advice.
Existing pixel-decoder constructors retain their owning/prefetching behavior.
ARI, DCS, DCR, KDC, QTK, SRW, RW2, RAF, NEF and ORF dummy queries skip
padded sensor-strip construction, retaining the existing geometry/crop branches; real pixel decoding is unchanged.
`plain_image_from_ifd` returns `DecoderFailed` for a zero width, height, samples-per-pixel or tile size
instead of reaching a zero chunk size in the strip and tile readers (#5580); an embedded-preview IFD
declaring width 0 had made the develop worker panic.
`data/cameras/hasselblad/h2d.toml` adds the Hasselblad H2D 3FR body (#5499), which upstream lacks:
black 0 and white 65535 as measured on the files, crop from their DefaultCrop tags, and the
ColorMatrix1 every H2D 3FR embeds. All other camera and lens data are unchanged.
The complete source delta is in
`MAPLE-PATCH.diff`; apply with `patch -p1 < MAPLE-PATCH.diff` on rawler 0.7.2.

The borrowed constructor uses a Rust reference, with no erased lifetime or new unsafe code.
On upgrade, copy the upstream crate, carry these constructors and lifetime parameter,
run the native dimensions/parity tests, then regenerate all workspace lockfiles.
This path patch is declared in the shared, Windows, Android and both standalone Linux workspaces.
