These small, genuine AVIF inputs exercise the API cache validator's ICC rejection
and cheap-check ordering (#3530). They contain constant RGB `[90, 140, 200]`;
RGBA fixtures add alpha `127`. Named `srgb` and `p3` profiles were authored by
Maple's real conversion/encoder with `withIccProfile()`. `kept-srgb.avif` retains
the ICC from a Maple-encoded PNG using `withMetadata()`. The oversized fixture
is 300×50; the other fixtures are 20×10.

The producer is the retained, qualified #3580 implementation at commit
`50d3ab6023eb3f96c9322ab73a87a356168af67f`, not the current-main validator binary.
`provenance.json` records its native/source hashes, exact recipes, fixture hashes,
and two byte-identical generation runs. Main at `e945d86c` cannot author or report ICC-tagged AVIF. The restored validator
therefore depends on the #3580 parent implementation, published as PR #4193 at
`87503f018b72594a881e3751cb15fe3bee189e59`. Tests read these inputs with an owned
native binary rebuilt from that parent, asserting actual metadata and full-decoder
integrity before rejection. The main-only setup/probe failures are retained as
evidence; this fixture corpus does not claim CICP primaries validation.

Regenerate from the repository root with that qualified producer library and
Bun 1.4.2, using the unchanged Maple builder source identified in the provenance:

```sh
MAPLE_NAPI=0 MAPLE_NATIVE_LIB=/path/to/qualified/libraw_ffi.dylib \
  bun test-fixtures/raster-metadata/avif-validation/generate.ts
```

Review the resulting hashes against `provenance.json`. The generator uses actual
Maple encode operations; it does not assemble or patch AVIF boxes. No user photos,
source originals, credentials, or platform-specific libraries are committed.
