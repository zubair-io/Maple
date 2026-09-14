//! napi-build emits the per-platform link arguments a Node addon needs.
//!
//! On macOS that is `-undefined dynamic_lookup`, which lets the `cdylib` ship
//! with the `napi_*` symbols unresolved for the host process to bind at load
//! time. On Linux/BSD it adds `-z nodelete` (a `pthread_key_create` destructor
//! use-after-unload bug), and on Windows-GNU it points the linker at
//! `libnode.dll`. Windows-MSVC and the Apple platforms need nothing further.

fn main() {
    napi_build::setup();
}
