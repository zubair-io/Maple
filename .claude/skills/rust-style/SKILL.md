---
name: rust-style
description: Maple's Rust style rules, adapted from the Google Rust Style Guide (https://google.github.io/styleguide/rustguide.html). Applies to all Rust under src/raw-pipeline/ (raw-core, raw-gpu, raw-ffi, raw-wasm, raw-napi, maple-cli, maple-pano, codegen) or src/windows/.
---

# Rust style for Maple

Maple's Rust follows the [Google Rust Style Guide](https://google.github.io/styleguide/rustguide.html), which itself defers to the official [Rust Style Guide](https://doc.rust-lang.org/nightly/style-guide/) and [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/). The rules below are that guide filtered to what applies here, with the places where Maple's own invariants are stricter called out. Where this file and `docs/best-practices.md` § "Rust core" disagree, best-practices wins.

Everything in `raw-core`, `raw-gpu`, and `maple-pano` is **library code**: API-design rules are binding. `maple-cli`, `codegen`, and the binding crates (`raw-ffi`, `raw-wasm`, `raw-napi`) are **application code**: the same rules are strong recommendations, and simplicity beats generality (CLAUDE.md principle 7, YAGNI).

Chromium-, Android-, and Fuchsia-only rules from the Google guide (one-file crates, flat crate layout, `chromium::import!`, no `async`, no `std::thread`, gtest interop, `panic=abort`) do **not** apply.

## Maple overrides — these win over the Google guide

These invariants outrank every style rule further down.

- **Never panic on bad input in library code.** The Google guide allows `panic!` for violated caller invariants; Maple does not for anything reachable from a RAW file, an XMP sidecar, or an FFI/WASM argument. Return `Result`. `unwrap`/`expect` belong in tests, binaries, and on invariants the code itself just established.
- **Determinism.** No wall-clock reads, no unseeded RNG, no parallel reductions with non-associative operators. Output must be byte-identical across native and WASM.
- **No filesystem access in `raw-core`.** Take and return bytes.
- **`rayon` for parallelism**, never hand-spawned threads in pixel stages.
- **No allocation inside the render loop**, and no extra WASM-boundary round trip per slider tick (CLAUDE.md § Performance invariants). This sharpens "prefer borrows over clones" into a hard rule on hot paths.
- **Comments:** the repo default is zero inline `//` comments; write one only for a non-obvious _why_. Doc comments (`///`) are for contracts — panics, errors, invariants, units, colour space — never for restating the name.
- **Immutable by default:** `let` over `let mut`, early-return guards over a binding mutated through `if` branches.
- **A raw-core stage change lands its WGSL counterpart in raw-gpu**, and shared constants come from `codegen` via `tools/codegen.sh` — never hand-edit a generated file.

## Formatting

- `rustfmt` with repo defaults (edition 2021, 100-column width) on changed files. Only `raw-ffi` is fully rustfmt-clean and gated by `cargo fmt --check -p raw-ffi`; untouched files in other crates keep their current formatting.
- `#[rustfmt::skip]` only for deliberate alignment (a 3×3 colour matrix, a LUT table) or generated code — never for taste.

## Modules and imports

- Name a file and its module after its primary item: `struct ToneCurve` lives in `tone_curve.rs`.
- Non-leaf modules (`mod.rs` or a file that declares submodules) hold `mod` declarations and re-exports, plus at most a little glue. Put the API in leaf modules.
- Avoid glob imports. Allowed: `use super::*;` in an inline `#[cfg(test)] mod tests`, enum-variant globs inside a function that is all about that enum, and `pub use` re-exports.
- One module path per `use` line — `use std::io::{Read, Write};` is fine, `use std::{io::Read, fmt::Display};` is not.
- Import a trait inside the function that needs it unless the whole file uses it.
- Call free functions through their module (`mem::swap(..)`, `simd::lerp(..)`), and use types unqualified (`Regex`, not `regex::Regex`). Qualify when a name is ambiguous (`io::Error`, `fmt::Result`) or rename with `as`.

## Ownership and borrowing

- Prefer unique ownership and borrows. Reach for `Rc`/`Arc` only when the alternative is unreasonably complex (shared wgpu device/queue handles are the common legitimate case).
- `.clone()` when a real copy is needed, not to silence the borrow checker. Cloning an `Arc` is cheap and fine.

## Function signatures

- Take the most general borrowed form: `&[T]` not `&Vec<T>`, `&str` not `&String`, `&T` not `&Box<T>`, `Option<&T>` not `&Option<T>` (clippy: `ptr_arg`, `borrowed_box`).
- Library code that only iterates may accept `impl IntoIterator`; returning `impl Iterator` is preferred over building a `Vec` the caller may not need. Return `Vec` when the function's job is to build a collection, the caller always needs one, or it must be indexed — pixel buffers are almost always this case.
- `impl Into<T>` parameters only in library APIs where ergonomics genuinely matter; almost never in application code.
- Replace an unclear `bool` parameter with a two-variant `enum` (`Orientation::Portrait`, not `true`). If a `bool` stays, name it at the call site with `/* flip_y */ true`.

## Errors

- `Option` when absence needs no explanation (checked arithmetic, lookup misses).
- `Result` with a typed error when the caller needs to tell causes apart (unsupported camera vs truncated file). Error types derive `Debug`, implement `Display` and `Error` (`thiserror` is already in the workspace), and are `Copy` when their fields allow.
- `panic!` only for bugs in Maple's own code — see the override above.
- Panic boundaries: `catch_unwind` is reserved for FFI/WASM entry points (`raw-ffi/src/error.rs`) as defence in depth, because unwinding across an `extern "C"` boundary is undefined behaviour. Nothing may rely on it for control flow.

## Types and traits

- Use a newtype, not a type alias, when values are easy to mix up and costly to confuse (linear vs gamma-encoded, Rec.2020 vs sRGB, pixels vs points).
- Named fields over tuples; `.0` only on single-field newtypes or very local tuples.
- Implement standard traits instead of look-alike methods (`FromStr`, not `parse_from`; `Default` whenever there is a `new()` with no arguments — clippy `new_without_default`). `#[derive]` whenever it can express the impl.
- Implement `Clone` on most types, `Copy` when the type will stay `Copy`, `PartialEq` unless `Eq` is actually needed (floats can't be `Eq`), `Hash + Eq` for map keys.
- Pair a `From` impl with an inherent `from_foo()` / `new()` constructor.
- Options structs (bags of public fields) implement `Default` so callers write `..Default::default()`.
- Prefer generics over `dyn Trait` in library code; dynamic dispatch blocks inlining in hot loops.
- Define a trait only for generic code, `impl Trait`/`dyn Trait`, or an extension trait — never just to group methods. Extension traits end in `Ext`.
- `#[non_exhaustive]` is for enums and structs crossing a team boundary. Maple is one workspace, and `#[repr(C)]` FFI enums must stay exhaustive, so this rarely applies.

## Naming

- Conversions follow std: `as_` (cheap borrow), `to_` (expensive or owned), `into_` (consumes `self`) — clippy `wrong_self_convention`.
- Constructors: `new()`, `new_with_foo()`, fallible `try_new()`; conversions `from_foo()`.
- Accessors: `foo()` returns `&T` (or `T` if `Copy`), `foo_mut()`, `set_foo()`, `take_foo()`, `replace_foo()`. Ship `is_empty()` with `len()`.
- Descriptive lifetimes (`'img`, `'buf`) except `'_` or a single generic `'a`.
- Generic parameters hint at their bound (`P: Pixel`, `S: Stage`); `T`/`U` only when unconstrained.
- Spell words out. Use only abbreviations a colour scientist or photographer would recognise without the code: `rgb`, `xyz`, `wb`, `dng`, `lut`, `ev` are fine; `cnt`, `img_proc_mgr` are not.

## Attributes and API surface

- `#[must_use]` on functions whose result is the whole point (pure colour transforms, builders) and on lazy computations. Not needed when the return type is already `#[must_use]` (`Result`).
- Make a public `fn` `const` only if it will stay `const`.
- Operator overloading only for its mathematical meaning (`Mul` for a matrix × vector is right; `+` to append a stage is not).
- Treat `#[doc(hidden)]` items you don't own as private.
- No code that runs before `main` (`ctor` and friends).

## Unsafe

- Only when no safe equivalent exists. Wrap it in a small safe abstraction kept away from business logic — in Maple that means `raw-ffi` and the SIMD kernels, not colour math.
- Every `unsafe` block carries a `// SAFETY:` comment saying why it is sound. Every `unsafe fn` and `unsafe trait` documents its contract in a `# Safety` doc section.
- A performance-motivated `unsafe` needs a benchmark in the PR.
- No unstable features in shipped crates. The `raw-wasm` nightly `-Z build-std` build is a toolchain flag, not a language feature, and is the existing exception.

## Implementation habits

- Annotate types where inference hides intent — especially after `.into()`, `.parse()`, and `.collect()`. Prefer `let x: Vec<f32> = ...collect();` over turbofish.
- `if let` / `match` instead of `is_some()` followed by `unwrap()`.
- When a panic is genuinely right, use `expect("why this can't fail")`, not `unwrap()`.
- Match enums exhaustively; a wildcard arm only for variants you deliberately ignore.
- `assert!` messages explain why the condition must hold or print the offending values, and say whether failure is caller misuse or an internal bug. Don't restate the condition.
- Keep iterator chains short and side-effect-free. Bind a non-trivial chain to a named variable before `for` instead of building it in the loop header. Avoid `for_each`.
- Build strings with `format!`/`write!` rather than `+` chains or repeated `str::replace`.

## Macros

Prefer, in order: functions/types/traits → `macro_rules!` → code generation (`codegen` crate) → `proc_macro`. Macros cost IDE support and readability; reach for one only when the plain-code version is genuinely worse.

## Docs and tests

- Every public item in library crates gets a `///` doc comment that states what a reader can't infer from the signature: units, colour space, value range, panics, errors.
- `//!` at the top of a module for its invariants (see `raw-core/src/api.rs`).
- Unit tests live in an inline `#[cfg(test)] mod tests` with `use super::*;`. Roughly one test per public function and per failure mode. The colour integration gate is `src/scripts/test_color_pipeline.sh`, which compares Auto against each camera's embedded JPEG (`docs/testing.md`); ACR comparisons are retired (#5000) and must not be reinstated.
