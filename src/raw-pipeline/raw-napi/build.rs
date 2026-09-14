//! napi-build emits the per-platform link arguments a Node addon needs.
//!
//! On macOS that is `-undefined dynamic_lookup`, which permits a `cdylib` to
//! ship with symbols left for the host process to bind at load time. On
//! Linux/BSD it adds `-z nodelete` (a `pthread_key_create` destructor
//! use-after-unload bug), and on Windows-GNU it points the linker at
//! `libnode.dll`. Windows-MSVC and the Apple platforms need nothing further.
//!
//! This crate does not actually depend on the macOS dynamic-lookup behaviour
//! for the `napi_*` symbols themselves: it enables napi's `dyn-symbols`
//! feature, so napi-sys binds those out of the running host with `libloading`
//! and the built dylib has no undefined `napi_*` symbols at all. See the
//! dependency comments in `Cargo.toml`.

fn main() {
    napi_build::setup();
}
