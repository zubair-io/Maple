Synthetic, tiny header fixtures for #3590. No user photographs or original RAWs.
`expected.json` records Sharp 0.34.5's metadata for the fields under test.
The Rust suite compares byte and seekable-file replies against it without
requiring Sharp in CI. The package separately compares dynamically generated
cases against a real Sharp installation.

Regenerate from the repo root after building raw-ffi/raw-napi and installing
Sharp under `src/api`:

```sh
bun tools/regenerate-raster-metadata-fixtures.ts
```

Review changed expectations against the installed Sharp version before committing.
Sharp's AVIF decoder name (`heif`) is projected by the package; the native probe
and encode formats keep the canonical codec name (`avif`).
