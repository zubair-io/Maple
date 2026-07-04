//! Static source-level gate (#1627 scope addition, ticket #441): assert
//! that `dither_and_quantize` (or its `quantize_u8` wrapper) is the LAST
//! pixel-value-mutating stage in every present display-encode chain.
//!
//! Extracted from `tests.rs` to keep both files under the 600-LOC hard
//! budget (#482/#772 convention). `super` is `pipeline::render`.
//!
//! Why a source-level (textual) test rather than an instrumented runtime
//! trace: `stage()` (`pipeline/mod.rs`) only times a closure — it has no
//! ordered log a test could introspect without adding always-on
//! bookkeeping to the hot per-tick render path (a budget violation per
//! CLAUDE.md § Performance invariants: "If a new feature adds allocation
//! inside the render loop, it does not ship"). The chain's stage order is
//! fixed at compile time by the literal sequence of `stage(...)` calls in
//! each function body, so a textual scan of the *source* is a faithful,
//! zero-runtime-cost proxy for "what actually runs last" — any reordering
//! shows up as a diff in this file's own source, and the test breaks the
//! next time someone edits the chain.
//!
//! Dither (blue-noise ±1 LSB offset before the `u8` round) must be the
//! terminal pixel-value pass because it operates on the FINAL display
//! values — dithering, then running another color stage on the now-8-bit-
//! quantized-and-noised buffer, would recolor the noise itself and defeat
//! the point (masking quantization bands). Byte-level post-processing that
//! is documented to operate on the already-quantized `u8` buffer (EXIF
//! orientation transpose, pixel crop) is NOT a pixel-VALUE stage — flipping
//! or cropping bytes doesn't touch color — so those are excluded from "the
//! chain" this test asserts about; see each chain's inline comment below
//! for the exact cutoff line used.

#![cfg(test)]

/// Every `stage("...", ...)` call name that mutates `Image` pixel values,
/// in file order, for a given source excerpt. Deliberately dumb (regex-free
/// substring scan) — the source lines are formatted consistently enough
/// (`stage("name"` at the start of a stage call) that a literal `stage("`
/// search is exact and doesn't require a real Rust parser.
fn stage_call_order(src: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(idx) = rest.find("stage(\"") {
        let after = &rest[idx + "stage(\"".len()..];
        let end = after.find('"').expect("unterminated stage name literal");
        out.push(&after[..end]);
        rest = &after[end..];
    }
    out
}

/// The three display-encode chains this crate ships. Each entry is
/// `(chain_name, stage_names_up_to_and_including_the_terminal_dither)`.
/// The cutoff for each chain is documented at its `stage("dither...")`
/// call site in `render/mod.rs` — everything after that line operates on
/// the quantized `u8` buffer (orientation, crop), not on `Image` pixels.
fn present_chains() -> Vec<(&'static str, Vec<&'static str>)> {
    let src = include_str!("mod.rs");

    // Slice each function body out of the shared source so a stage name
    // appearing in one chain (e.g. "agx") doesn't get attributed to
    // another chain's order. Slicing on the `pub fn NAME` signature is
    // stable because these three functions are declared in this exact
    // file (`render/mod.rs`) — if one moves, `expect` below fails loudly
    // rather than silently checking the wrong span.
    let slice_fn = |name: &str| -> &str {
        let start = src
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("dither_terminal_tests: `fn {name}` not found in mod.rs — did it move? update this test's slicer"));
        // End at the next top-level `pub fn ` / `fn ` after this one, or EOF.
        let after_sig = &src[start + name.len()..];
        let next_fn_rel = after_sig[1..]
            .find("\npub fn ")
            .or_else(|| after_sig[1..].find("\nfn "))
            .map(|i| i + 1);
        match next_fn_rel {
            Some(rel) => &src[start..start + name.len() + rel],
            None => &src[start..],
        }
    };

    vec![
        (
            "render_display_from_raw (RAW develop path)",
            stage_call_order(slice_fn("render_display_from_raw")),
        ),
        (
            "render_from_scene_linear (synthetic, no slider chain)",
            stage_call_order(slice_fn("render_from_scene_linear")),
        ),
        (
            "render_from_scene_linear_with_chain (synthetic, full slider chain)",
            stage_call_order(slice_fn("render_from_scene_linear_with_chain")),
        ),
    ]
}

/// Stages that are documented (see `render/mod.rs` inline comments at their
/// call sites) to run on the already-quantized `u8` byte buffer rather than
/// on `Image` pixel values — EXIF orientation transpose and pixel crop.
/// These may legitimately follow dither; they are excluded from "the last
/// PIXEL-VALUE stage" this test asserts about.
const BYTE_LEVEL_POST_DITHER_STAGES: &[&str] = &["apply_orientation", "crop"];

#[test]
fn dither_is_the_last_pixel_stage_in_every_present_chain() {
    for (chain_name, stages) in present_chains() {
        assert!(
            !stages.is_empty(),
            "{chain_name}: found zero `stage(...)` calls — slicer regression?"
        );
        let pixel_stages: Vec<&str> = stages
            .iter()
            .copied()
            .filter(|s| !BYTE_LEVEL_POST_DITHER_STAGES.contains(s))
            .collect();
        let last = *pixel_stages
            .last()
            .unwrap_or_else(|| panic!("{chain_name}: no pixel-value stages found"));
        assert!(
            last == "dither_and_quantize" || last == "synth_dither_and_quantize",
            "{chain_name}: last PIXEL-VALUE stage is {last:?}, expected the dither \
             terminal (#441) to be last. Full pixel-stage order: {pixel_stages:?} \
             (raw order incl. byte-level tail: {stages:?})"
        );
        // Belt-and-suspenders: dither must appear EXACTLY once (a repeat
        // would mean the buffer round-trips through 8-bit twice, doubling
        // the dither noise amplitude).
        let dither_count = stages
            .iter()
            .filter(|s| **s == "dither_and_quantize" || **s == "synth_dither_and_quantize")
            .count();
        assert_eq!(
            dither_count, 1,
            "{chain_name}: dither stage appears {dither_count} times, expected exactly 1"
        );
        // And the byte-level tail (if present) must come strictly AFTER
        // dither in the raw (unfiltered) order — i.e. dither is not
        // sandwiched between two byte-level stages, which would imply a
        // pixel-value stage sneaking in after orientation/crop.
        let dither_idx = stages
            .iter()
            .position(|s| *s == "dither_and_quantize" || *s == "synth_dither_and_quantize")
            .unwrap();
        assert_eq!(
            dither_idx,
            stages.len() - 1 - BYTE_LEVEL_POST_DITHER_STAGES
                .iter()
                .filter(|b| stages.contains(b))
                .count(),
            "{chain_name}: dither is not immediately followed only by the known \
             byte-level tail. Full order: {stages:?}"
        );
    }
}

#[test]
fn stage_call_order_parses_a_known_sequence() {
    let src = r#"
        stage("auto_exposure", || auto_exposure::apply(&mut scene, model));
        stage("white_balance", || white_balance::apply(&mut scene));
        stage("dither_and_quantize", || encode::dither_and_quantize(&mut scene));
    "#;
    assert_eq!(
        stage_call_order(src),
        vec!["auto_exposure", "white_balance", "dither_and_quantize"]
    );
}
