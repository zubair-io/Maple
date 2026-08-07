//! Film-look session plumbing gates (epic #2683, Task 9).
//!
//! `WebLiveSession::set_film_lut` / `clear_film_lut` are `#[wasm_bindgen]`
//! methods on a struct that owns an `OffscreenCanvas` and drives WebGPU via
//! `wasm_bindgen_futures` — wasm32-only, so they can't run on this host. But
//! everything they DO — decode a `.mlut` grid, fold it (plus its content-
//! identity key) into the [`raw_gpu::FullChainInputs`] the live chain
//! consumes every tick — is the platform-neutral `chain_inputs_for_model` /
//! `build_full_chain_inputs` plumbing this file exercises directly, the same
//! split `tests.rs` uses for `render_gpu_core`. Session set/clear is a session
//! FIELD write (`self.film_lut = Some(lut)`) feeding these exact functions, so
//! covering the functions covers the session behaviour; only the wasm-bindgen
//! surface itself is deferred to live browser verification (Task 12).

use super::tests::{gpu_available, synthetic_dng_path};
use raw_core::film::FilmLut;
use raw_core::xmp::AdjustmentModel;
use raw_gpu::{GpuContext, LiveSession};

/// A tiny, deliberately NON-identity 2x2x2 lattice: every node maps to solid
/// red. At `film_strength: 100` (the model default) this fully overrides
/// whatever colour the develop produced, so a render with this LUT loaded is
/// guaranteed to differ from a render with `film_lut: None` — no reliance on
/// the source image's own colour distribution.
fn solid_red_lut() -> FilmLut {
    let mut data = Vec::with_capacity(2 * 2 * 2 * 3);
    for _ in 0..(2 * 2 * 2) {
        data.extend_from_slice(&[1.0, 0.0, 0.0]);
    }
    FilmLut { size: 2, data }
}

/// Pure-logic gate (no GPU, no fixture): loading a film LUT changes exactly
/// the four film fields on [`raw_gpu::FullChainInputs`] and nothing else about
/// the chain-inputs shape, and `None` reproduces the "no look" zero/empty
/// state `WebLiveSession::clear_film_lut` resets to. Runs everywhere,
/// including CI without the DNG fixture or a GPU.
#[test]
fn chain_inputs_fold_film_lut_size_key_and_data() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .nth(3)
        .expect("CARGO_MANIFEST_DIR is not three levels below the repo root");
    let path = root.join("src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    if !path.exists() {
        eprintln!("chain_inputs_fold_film_lut: synthetic DNG fixture absent — skipping");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");
    let model = AdjustmentModel {
        film_strength: 72.0,
        ..AdjustmentModel::default()
    };

    let no_look = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, None, 0);
    assert_eq!(no_look.film_lut_size, 0, "no look ⇒ size 0");
    assert_eq!(no_look.film_lut_key, 0, "no look ⇒ key 0");
    assert!(no_look.film_lut_data.is_empty(), "no look ⇒ empty grid");
    // `film_strength` rides the model regardless of whether a look is loaded —
    // it is inert without a grid (the `film_lut_size > 0` gate), but the value
    // itself is not session state.
    assert_eq!(no_look.film_strength, 72.0);

    let lut = solid_red_lut();
    let loaded = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, Some(&lut), 4242);
    assert_eq!(loaded.film_lut_size, 2, "loaded look ⇒ the grid's own size");
    assert_eq!(loaded.film_lut_key, 4242, "loaded look ⇒ the caller's key");
    assert_eq!(
        loaded.film_lut_data,
        lut.data,
        "loaded look ⇒ the grid's own flat data, verbatim"
    );
    assert_eq!(loaded.film_strength, 72.0);

    // Clearing (the `set_film_lut(&[], _)` / `clear_film_lut` contract) must
    // reproduce the no-look inputs exactly — a session that loads then clears
    // a look renders identically to one that never loaded it.
    let cleared = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, None, 0);
    assert_eq!(cleared.film_lut_size, no_look.film_lut_size);
    assert_eq!(cleared.film_lut_key, no_look.film_lut_key);
    assert_eq!(cleared.film_lut_data, no_look.film_lut_data);
}

/// THE SESSION SET/CLEAR ROUND-TRIP GATE: on the SAME persistent [`LiveSession`]
/// — the resident state `WebLiveSession` holds across ticks — loading a
/// (strongly non-identity) film LUT changes the rendered surface, and
/// clearing it again reproduces the original no-look render exactly. This is
/// the render-visible half of `set_film_lut` / `clear_film_lut`: the session
/// never re-uploads or recompiles between the three renders (film-look is
/// display-tail, like grain/split-tone — no prefix re-develop), so any
/// difference is attributable ONLY to the film fields on
/// [`raw_gpu::FullChainInputs`], exactly as a real `WebLiveSession::render`
/// tick after `set_film_lut` would produce.
///
/// Soft-passes without a GPU adapter or the synthetic DNG fixture (mirrors
/// every other gate in this module).
#[test]
fn set_and_clear_film_lut_round_trips_through_the_same_session() {
    let Some(path) = synthetic_dng_path() else {
        eprintln!(
            "set_and_clear_film_lut_round_trips: synthetic DNG fixture absent — skipping (soft pass)"
        );
        return;
    };
    if !gpu_available() {
        eprintln!("set_and_clear_film_lut_round_trips: no GPU adapter — skipping (soft pass)");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");
    let model = AdjustmentModel::default();

    let ctx = pollster::block_on(GpuContext::new_async()).expect("gpu context");
    let target = super::effective_target_long_edge(None, &ctx);
    let (rgba, w, h, _prefix) =
        super::develop_prefix_rgba(&raw_img, &bytes, ext, &model, target).expect("develop");
    let session = LiveSession::new(&ctx, &rgba, w, h).expect("session upload");

    let no_look_inputs = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, None, 0);
    let baseline = pollster::block_on(session.render_async(&ctx, &no_look_inputs, None))
        .expect("baseline render ok")
        .expect("baseline render");

    let lut = solid_red_lut();
    let loaded_inputs =
        super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, Some(&lut), 7);
    let with_look = pollster::block_on(session.render_async(&ctx, &loaded_inputs, None))
        .expect("with-look render ok")
        .expect("with-look render");

    assert_eq!(baseline.len(), with_look.len(), "surface length mismatch");
    let differing = baseline
        .iter()
        .zip(&with_look)
        .filter(|(a, b)| a != b)
        .count();
    assert!(
        differing > baseline.len() / 20,
        "loading a solid-red film LUT at full strength changed only {differing} / {} bytes — \
         expected the vast majority of pixels to move (film_lut_key {} not folding into the \
         chain, or the FilmLutPass skip gate not lifting for film_lut_size > 0)",
        baseline.len(),
        loaded_inputs.film_lut_key
    );

    // Clear ⇒ back to `(None, 0)` inputs ⇒ byte-identical to the baseline —
    // the same session, same develop, only the film fields reverted.
    let cleared_inputs = super::chain_inputs_for_model(&raw_img, &bytes, ext, &model, None, 0);
    let cleared = pollster::block_on(session.render_async(&ctx, &cleared_inputs, None))
        .expect("cleared render ok")
        .expect("cleared render");
    assert_eq!(
        cleared, baseline,
        "clearing the film LUT must reproduce the original no-look render byte-for-byte"
    );
}
