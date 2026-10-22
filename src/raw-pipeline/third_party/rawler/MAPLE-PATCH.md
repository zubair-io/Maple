# Rawler 0.7.2 metadata source patch (#5163)

The source matches the previously vendored rawler 0.7.2, except `src/rawsource.rs`.
The crate moved from `vendor/` to `third_party/` as required for path patches.
`RawSource` now carries a source lifetime and adds a borrowed-slice constructor.
A separate metadata file constructor omits whole-file population and prefetch advice.
Existing pixel-decoder constructors retain their owning/prefetching behavior.
No decoder or camera/lens data changes. The complete source delta is in
`MAPLE-PATCH.diff`; apply with `patch -p1 < MAPLE-PATCH.diff` on rawler 0.7.2.

The borrowed constructor uses a Rust reference, with no erased lifetime or new unsafe code.
On upgrade, copy the upstream crate, carry these constructors and lifetime parameter,
run the native dimensions/parity tests, then regenerate all workspace lockfiles.
This path patch is declared in the shared, Windows and Android workspaces.
