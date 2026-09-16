# Apple sidecar qualification linkage — #3633

Candidate: `ac1431903278619507a6342e293feb4e7095c2ae`, pipeline version 6.
Recorded at `2026-09-16T02:06:20Z`: **12 executed, 0 failed, 0 skipped**.
This qualifies the macOS host sidecar contract; it is not iOS or UI qualification.

## Fresh native build and staging

From `src/raw-pipeline`:

```bash
MACOSX_DEPLOYMENT_TARGET=14.0 CARGO_BUILD_JOBS=4 cargo build --locked --release -p raw-ffi --features gpu,pano
```

Regenerated `RawPipeline.h` using the crate's committed `cbindgen.toml`,
preprocessed it with host clang, and verified all 98 expected host FFI symbols
against the new archive. The iOS-only `maple_pano_ort_selftest` declaration was
excluded from this host check, following the existing Apple CI recipe.

Copied the new `src/raw-pipeline/target/release/libraw_ffi.a` into
`src/apple/Frameworks/RawPipeline.xcframework/macos-arm64_x86_64/libraw_ffi.a`
and staged the generated header in that slice's `Headers` directory and
`src/apple/Packages/MapleCore/Sources/MapleCore/include`. This is a host arm64
qualification archive, not a newly built universal or iOS framework.

Archive SHA256 (also verified against SwiftPM's copied debug archive):
`0dc2c489df437154202ccccaa9cbf61096037e67d46ff8d1d454518716b0f5f3`.

## Force and verify relinking

SwiftPM copied the changed archive but initially reused an older test
executable. That first incremental pass was not accepted as current-binding
evidence. When only the native archive changes, explicitly force relinking
and verify the link step before recording qualification.

From repository root, remove only the generated test executable:

```bash
rm src/apple/Packages/MapleCore/.build/arm64-apple-macosx/debug/MapleCorePackageTests.xctest/Contents/MacOS/MapleCorePackageTests
CARGO_BUILD_JOBS=4 bash tools/qualification/record.sh sidecar_contract_apple xctest-macos -- swift test --package-path src/apple/Packages/MapleCore --disable-automatic-resolution --jobs 4 --filter SidecarTransactionContract
```

The accepted run reported `[14/15] Linking MapleCorePackageTests` and then
12 passing tests with no skips. Executable modification time was
`2026-09-15 22:06:09 America/New_York`, after the fresh archive was staged.
Executable SHA256:
`422aa3acb36230ef8bc95bcf22b9da0f7e8cb919389f3e73ce63b24db0bc4e45`.

`Package.resolved` remained unchanged, SHA256:
`d36b54409779cad88f5de5f5182477f96ffc00b800d93770947fe0ebba36920b`.
The committed evidence is `sidecar_contract_apple.json`; the exact repository-
relative test command and candidate commit are recorded there.
