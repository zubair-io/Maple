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

/// Slice one function body out of `src`, so a stage name appearing in one
/// chain (e.g. "agx") doesn't get attributed to another chain's order.
///
/// Slicing on the `fn NAME(` signature is stable because each function named
/// below is declared in the file it is looked up in — if one moves, the panic
/// fires loudly rather than the test silently checking the wrong span.
fn slice_fn<'a>(src: &'a str, name: &str) -> &'a str {
    let start = src.find(&format!("fn {name}(")).unwrap_or_else(|| {
        panic!(
            "dither_terminal_tests: `fn {name}` not found — did it move? \
             update this test's slicer"
        )
    });
    // End at whichever comes first of the next top-level `pub fn ` / `fn `,
    // or EOF. Taking the FIRST of the two matters: a private function
    // followed by a public one must not swallow the private one's body.
    let after_sig = &src[start + name.len()..];
    let rest = &after_sig[1..];
    let next_fn_rel = match (rest.find("\npub fn "), rest.find("\nfn ")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (found, None) | (None, found) => found,
    }
    .map(|i| i + 1);
    match next_fn_rel {
        Some(rel) => &src[start..start + name.len() + rel],
        None => &src[start..],
    }
}

/// The colour chain every display-referred render runs, up to but NOT
/// including a terminal quantize.
///
/// Since #943 the quantize is no longer inside this function: the depth is the
/// caller's choice (8-bit for the canvas and JPEG/PNG, 16-bit for the TIFF
/// master), so each terminal appends its own. `chain_is_depth_agnostic` below
/// pins that separation, and every entry in [`present_chains`] re-attaches this
/// prefix so each chain is still checked end to end.
fn colour_chain() -> Vec<&'static str> {
    stage_call_order(slice_fn(include_str!("mod.rs"), "render_display_scene"))
}

/// Every present display-encode chain this crate ships, as the full ordered
/// stage list a render actually executes. Each entry is
/// `(chain_name, stage_names_up_to_and_including_the_terminal_quantize)`.
/// Everything after the quantize operates on the already-quantized integer
/// buffer (orientation, crop), not on `Image` pixels.
fn present_chains() -> Vec<(&'static str, Vec<&'static str>)> {
    let render_src = include_str!("mod.rs");
    let export_src = include_str!("export.rs");
    let synthetic_src = include_str!("synthetic.rs");

    // A depth terminal's own stages, appended to the shared colour chain, is
    // the sequence a render of that depth really runs.
    let terminal = |src: &'static str, name: &str| -> Vec<&'static str> {
        let mut stages = colour_chain();
        stages.extend(stage_call_order(slice_fn(src, name)));
        stages
    };

    vec![
        (
            "render_display_from_raw (RAW develop path, 8-bit display terminal)",
            terminal(render_src, "render_display_from_raw"),
        ),
        (
            "export finish_eight (JPEG / PNG terminal)",
            terminal(export_src, "finish_eight"),
        ),
        (
            "export finish_sixteen (16-bit TIFF terminal)",
            terminal(export_src, "finish_sixteen"),
        ),
        (
            "render_from_scene_linear (synthetic, no slider chain)",
            stage_call_order(slice_fn(synthetic_src, "render_from_scene_linear")),
        ),
        (
            "render_from_scene_linear_with_chain (synthetic, full slider chain)",
            stage_call_order(slice_fn(
                synthetic_src,
                "render_from_scene_linear_with_chain",
            )),
        ),
    ]
}

/// Stages that are documented (see `render/mod.rs` inline comments at their
/// call sites) to run on the already-quantized `u8` byte buffer rather than
/// on `Image` pixel values — EXIF orientation transpose and pixel crop.
/// These may legitimately follow dither; they are excluded from "the last
/// PIXEL-VALUE stage" this test asserts about.
const BYTE_LEVEL_POST_DITHER_STAGES: &[&str] = &["apply_orientation", "crop"];

/// The terminal quantize stage names, one per output depth.
const QUANTIZE_STAGES: &[&str] = &[
    "dither_and_quantize",
    "dither_and_quantize_u16",
    "synth_dither_and_quantize",
];

fn is_quantize(stage: &str) -> bool {
    QUANTIZE_STAGES.contains(&stage)
}

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
            is_quantize(last),
            "{chain_name}: last PIXEL-VALUE stage is {last:?}, expected the dither \
             terminal (#441) to be last. Full pixel-stage order: {pixel_stages:?} \
             (raw order incl. byte-level tail: {stages:?})"
        );
        // Belt-and-suspenders: the quantize must appear EXACTLY once (a repeat
        // would mean the buffer round-trips through an integer depth twice,
        // doubling the dither noise amplitude).
        let dither_count = stages.iter().filter(|s| is_quantize(s)).count();
        assert_eq!(
            dither_count, 1,
            "{chain_name}: dither stage appears {dither_count} times, expected exactly 1"
        );
        // And the byte-level tail (if present) must come strictly AFTER
        // dither in the raw (unfiltered) order — i.e. dither is not
        // sandwiched between two byte-level stages, which would imply a
        // pixel-value stage sneaking in after orientation/crop.
        let dither_idx = stages.iter().position(|s| is_quantize(s)).unwrap();
        assert_eq!(
            dither_idx,
            stages.len()
                - 1
                - BYTE_LEVEL_POST_DITHER_STAGES
                    .iter()
                    .filter(|b| stages.contains(b))
                    .count(),
            "{chain_name}: dither is not immediately followed only by the known \
             byte-level tail. Full order: {stages:?}"
        );
    }
}

/// The shared colour chain must not quantize (#943).
///
/// Every terminal appends its own quantize at its own depth. If one ever crept
/// back into the shared chain, the 16-bit export would silently become an
/// 8-bit buffer widened into a 16-bit container — which is exactly the defect
/// the depth split exists to prevent, and it would still pass every assertion
/// above because the chain would end on a legitimate-looking quantize.
#[test]
fn the_shared_colour_chain_is_depth_agnostic() {
    let chain = colour_chain();
    assert!(
        !chain.is_empty(),
        "render_display_scene: found zero `stage(...)` calls — slicer regression?"
    );
    let quantizers: Vec<&str> = chain.iter().copied().filter(|s| is_quantize(s)).collect();
    assert!(
        quantizers.is_empty(),
        "render_display_scene must leave the terminal depth to its callers, but it \
         calls {quantizers:?}. Full chain: {chain:?}"
    );
}

/// Both export depths must run the identical colour chain — that is what makes
/// a 16-bit TIFF and the 8-bit canvas the same picture at different precision.
#[test]
fn both_export_depths_share_the_display_colour_chain() {
    let chains = present_chains();
    let find = |needle: &str| -> Vec<&'static str> {
        chains
            .iter()
            .find(|(name, _)| name.contains(needle))
            .map(|(_, stages)| stages.clone())
            .unwrap_or_else(|| panic!("no chain matching {needle:?}"))
    };
    let eight = find("finish_eight");
    let sixteen = find("finish_sixteen");
    let display = find("render_display_from_raw");

    // Strip each chain's own terminal; what remains must be identical.
    let colour_prefix = |stages: Vec<&'static str>| -> Vec<&'static str> {
        stages.into_iter().filter(|s| !is_quantize(s)).collect()
    };
    assert_eq!(colour_prefix(eight), colour_prefix(sixteen.clone()));
    assert_eq!(colour_prefix(sixteen), colour_prefix(display));
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
