# avif-serialize 0.8.8 — Maple colour patch (#3580)

This copy preserves the upstream licence and source distribution. The original
`vendor/avif-serialize` stays unchanged. Both the raw-pipeline and separate Windows
workspaces patch this crate, so Apple, WASM, Windows and API builds agree.

The patch is `../../patches/avif-serialize-0.8.8-colour.patch`.
The muxer writes an ICC `colr` property of type `prof`, associates it only with the colour item, and allows room for the additional property and association. Existing NCLX properties are retained.

On upgrade, unpack the upstream crate into this directory, retain its licence,
apply the patch with `patch -p1 < ../../patches/avif-serialize-0.8.8-colour.patch`,
and resolve any API changes. Update both workspace patches/lockfiles. Run the
raw-core AVIF suite and the Maple metadata/colour independent-reader tests.
Do not apply this patch inside `vendor/`; `cargo vendor` overwrites that tree.

The property layout follows the reference [libavif colour writer](https://github.com/AOMediaCodec/libavif/blob/main/src/write.c): `prof` carries ICC bytes and can coexist with `nclx` (one box per colour type). The matching CICP contract follows the [AVIF specification](https://aomediacodec.github.io/av1-avif/v1.2.0.html).
