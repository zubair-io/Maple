# ravif 0.13.0 — Maple colour patch (#3580)

This copy preserves the upstream licence and source distribution. The original
`vendor/ravif` stays unchanged. Both the raw-pipeline and separate Windows
workspaces patch this crate, so Apple, WASM, Windows and API builds agree.

The patch is `../../patches/ravif-0.13.0-colour.patch`.
Ravif exposes Display P3 primaries and ICC profile input, writes matching AV1 CICP and passes both to the muxer. Matrix coefficients, transfer, range, compression and alpha semantics stay unchanged.

On upgrade, unpack the upstream crate into this directory, retain its licence,
apply the patch with `patch -p1 < ../../patches/ravif-0.13.0-colour.patch`,
and resolve any API changes. Update both workspace patches/lockfiles. Run the
raw-core AVIF suite and the Maple metadata/colour independent-reader tests.
Do not apply this patch inside `vendor/`; `cargo vendor` overwrites that tree.
