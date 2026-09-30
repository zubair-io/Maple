# avif-parse 2.1.0 — Maple seekable metadata patch

This copy preserves the upstream MPL-2.0 license and full AVIF decoder API.
The two workspace patch entries, in `src/raw-pipeline/Cargo.toml` and
`src/windows/Cargo.toml`, make Apple, Web, API, and Windows resolve the same
container parser.

For #3620, `read_avif_layout(Read + Seek)` returns validated primary item
extents and alpha presence while seeking over media and unknown top-level
boxes. It uses the same `ftyp`, `meta`, property, item-reference, and `iloc`
parsers as `read_avif`, including iloc v2, disjoint extents and 64-bit boxes.
The full decoder still buffers and assembles the original payloads. The
seekable path also preserves its extent validation and whole-mdat consumption
semantics. Truncated bodies retain the existing parser-state failure.

`raw-core` reads AV1 sequence-header OBUs through that logical extent stream,
skips frame payloads, and lets rav1d parse dimensions. It does not replace
AV1 dimensions with `ispe`. It validates subsequent OBU headers too, preserving
the existing corrupt-stream behavior, and applies container rotation/mirror
to reported dimensions in the shared raster probe.

The upstream delta is recorded in
`patches/avif-parse-2.1.0-seekable-layout.patch`. To refresh this copy, unpack
upstream 2.1.0 into `third_party/avif-parse`, keep this document, and apply:

```sh
patch -p1 -d third_party/avif-parse < patches/avif-parse-2.1.0-seekable-layout.patch
```

When upgrading, port the small shared-container extraction and `src/seek.rs`,
then rerun `cargo test -p raw-core --features avif metadata_reader --lib`,
the full core suite, and `tests/avif_corruption.rs`. The reader tests compare
the new probe to a frozen pre-refactor byte probe, across real encoder
fixtures, every truncation point, corrupt headers, alpha, all container
transforms, iloc versions, and read budgets on files containing large payloads
or metadata near the end. `cargo vendor` does not regenerate this path copy.
