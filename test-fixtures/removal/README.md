# Removal persistence interoperability

`basic/` is a tiny synthetic DNG plus lossless mask, HDR patch, preparation request,
accepted records, and a foreign XMP envelope. It contains no personal photographs.
Rust, Swift, and browser WASM tests use the same bytes to exercise real companion
publication and sidecar saves. Patch values include negative scene values and an
HDR channel above one; preserving these values is part of the contract.
`request.txt` and `records.txt` store the exact compact JSON wire text produced
by Rust, including its canonical attribute ordering, rather than a reformatted
presentation.

Regenerate from the repository root:

```sh
cargo run --manifest-path src/raw-pipeline/Cargo.toml -p raw-core --features test-support --example removal-fixture -- test-fixtures/removal/basic
cp test-fixtures/removal/basic/* src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/removal/
```

The Apple copy is required by Swift Package Manager's resource boundary. Commit
both copies together and verify that they remain byte-identical.
