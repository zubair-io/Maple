# Apple sidecar qualification linkage — #3633

Candidate: `fe3df490175fec39e0fa41b4817ac617cfd4d47b`, pipeline version 6.
Recorded at `2026-09-16T02:46:02Z`: **12 executed, 0 failed, 0 skipped**.
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
`e5829cbeb8ce306cee21172e34f44675bddf750956f26a230788a4692daf4e4b`.

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
`2026-09-15 22:45:44 America/New_York`, after the fresh archive was staged.
Executable SHA256:
`79466bbddcfd40b3dcae3efe62dd400643b2091d7148f2ccc60a60e879bda78d`.

`Package.resolved` remained unchanged, SHA256:
`d36b54409779cad88f5de5f5182477f96ffc00b800d93770947fe0ebba36920b`.
The committed evidence is `sidecar_contract_apple.json`; the exact repository-
relative test command and candidate commit are recorded there.
