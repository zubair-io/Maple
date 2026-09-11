# rav1d 1.1.0 — Maple patch

This is an **in-tree copy of the upstream `rav1d` 1.1.0 crate** (unpacked from
crates.io), carrying exactly one Maple change. The workspace resolves it
through

```toml
# src/raw-pipeline/Cargo.toml
[patch.crates-io]
rav1d = { path = "third_party/rav1d" }
```

so every build uses it: the Linux API/server build, the Windows DLL, the WASM
build, and the Apple offline xcframework build alike.

## What changed

Nine functions in `src/lib.rs` — and nothing else in the crate — are declared
`extern "C-unwind"` instead of `extern "C"`:

`dav1d_default_settings`, `dav1d_open`, `dav1d_parse_sequence_header`,
`dav1d_send_data`, `dav1d_get_picture`, `dav1d_close`, `dav1d_picture_unref`,
`dav1d_data_create`, `dav1d_data_unref`.

Those are exactly the nine entry points `raw-core/src/avif_decode.rs` calls.
`extern "C-unwind"` is the same C calling convention with the same symbol names
— a C caller of the staticlib sees no difference — it only permits a Rust panic
to unwind back out through the frame.

## Why (#3517)

rav1d panics on some corrupt AV1 streams. Zeroing the last byte of a small
solid-colour AVIF leaves the container, `ispe` and sequence header valid but
makes the decoder hit `called Option::unwrap() on a None value` at
`src/decode.rs:4997`.

Since Rust 1.81 a panic that reaches a plain `extern "C"` frame does not
unwind — it aborts the process. rav1d's own Rust-ABI entry points
(`rav1d_open` / `rav1d_send_data` / `rav1d_get_picture` / `rav1d_close`) are
`pub(crate)`, so the `dav1d_*` C shims are the only surface available to us and
that abort was unavoidable from the caller's side. It killed the API's
`raw_ffi.child.ts` process before raw-ffi's `catch_panic_rc` barrier could turn
the panic into an error return, and killed the whole test binary under
`bun test`.

With the shims marked `C-unwind`, the panic unwinds into the
`std::panic::catch_unwind` in `raw-core/src/avif_decode.rs`, which reports it as
a normal `Error::Decode` ("AVIF decode panicked inside rav1d (corrupt
stream)"). A corrupt file is then rejected like any other bad input instead of
taking the process down.

Upstreaming this (or making the Rust API `pub`) is the long-term fix; until
then the patch lives here.

## How to re-apply on an upgrade

1. Fetch the new upstream crate and replace the tree, keeping this file:

   ```bash
   cd src/raw-pipeline
   cargo fetch                      # populates ~/.cargo/registry for the new version
   NEW=~/.cargo/registry/src/index.crates.io-*/rav1d-<new version>
   rm -rf third_party/rav1d
   mkdir -p third_party/rav1d
   cp -R "$NEW"/. third_party/rav1d/
   rm -f third_party/rav1d/.cargo-ok third_party/rav1d/.gitignore
   ```

   `.cargo-checksum.json` must NOT be present — it only belongs in a
   `cargo vendor` tree, and cargo would verify the patched `src/lib.rs` against
   it and fail.

2. Re-apply the ABI patch and re-add this file:

   ```bash
   cd third_party/rav1d
   patch -p1 < ../../patches/rav1d-1.1.0-c-unwind.patch
   ```

   If the hunks no longer apply, redo them by hand (the change is mechanical:
   `extern "C"` → `extern "C-unwind"` on the nine functions listed above),
   then regenerate the patch file against the pristine upstream copy:

   ```bash
   cd src/raw-pipeline
   diff -u --label a/src/lib.rs --label b/src/lib.rs \
     "$NEW/src/lib.rs" third_party/rav1d/src/lib.rs \
     >> patches/rav1d-<new version>-c-unwind.patch   # keep the prose header
   ```

3. Bump the version requirement in `src/raw-pipeline/Cargo.toml`
   (`[workspace.dependencies] rav1d`) and confirm the override is live:

   ```bash
   cargo tree -p raw-core --features avif -i rav1d   # must print the third_party path
   ```

4. Re-vendor, then check the tree is complete:

   ```bash
   cargo vendor vendor && scripts/re-apply-patches.sh
   git status --ignored --short third_party | grep '^!!'   # must print nothing
   ```

   `vendor/rav1d` should not reappear — a patched path dependency is not a
   registry source, so `cargo vendor` does not emit it.

5. Run the corruption sweep, which is the regression guard for this patch:

   ```bash
   cargo test -p raw-core --features avif --test avif_corruption
   ```

   Before the patch that test **aborted** the test binary (exit 134) instead of
   failing.

## Note for `cargo vendor` / the Apple offline build

`vendor/` no longer contains rav1d, by design. The Apple xcframework build
(`src/apple/scripts/build-xcframework.sh`, `--offline` with
`source.crates-io.replace-with="vendored-sources"`) picks rav1d up from this
directory instead, because a `[patch.crates-io]` path entry is resolved from the
filesystem and is unaffected by source replacement. Do not add rav1d back to
`vendor/`.
