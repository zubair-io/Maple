//! The capture decode on the Linux preview (#5380): a white-balance drag
//! renders the resident capture through the creative stage, within one 8-bit
//! step of a fresh sized develop of the same model, without re-decoding or
//! allocating a GPU buffer after its first tick. The physical gate runs the
//! shared S3 matrix on real bodies (fixture-gated).
use super::*;
use raw_core::pipeline::{render_sized_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_core::test_support::capture_seam::{at, combinations, max_step, targets, EDGE, FIXTURES};

struct Source {
    raw: RawImage,
    bytes: Vec<u8>,
    ext: String,
}

impl Source {
    fn read(path: &std::path::Path) -> Self {
        let bytes = std::fs::read(path).unwrap();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap()
            .to_ascii_lowercase();
        let raw = raw_core::decode::decode_bytes(&bytes, &ext).unwrap();
        Self { raw, bytes, ext }
    }

    fn refined(&self, model: &AdjustmentModel, edge: u32) -> Vec<u8> {
        render_sized_from_raw_with_quality_and_source(
            &self.raw,
            model,
            RenderQuality::Amaze,
            Some(RawInput::Bytes {
                bytes: &self.bytes,
                ext: &self.ext,
            }),
            edge,
        )
        .unwrap()
        .2
    }
}

/// The tick `render` presents, read back.
fn shown(
    preview: &mut GpuPreview,
    ctx: &GpuContext,
    source: &Source,
    model: &AdjustmentModel,
) -> Vec<u8> {
    let token = CancelToken::new();
    assert!(preview
        .render(ctx, &source.raw, &source.bytes, &source.ext, model, &token)
        .unwrap());
    let rgb = preview
        .session
        .render_to_buffer(ctx, &preview.profile.inputs, &token)
        .unwrap()
        .unwrap();
    let (w, h) = preview.session.dims();
    raw_core::image::apply_orientation(&rgb, w, h, source.raw.orientation).2
}

fn drag(
    ctx: &GpuContext,
    source: &Source,
    name: &str,
    decode_model: &AdjustmentModel,
    edge: u32,
) -> u8 {
    let mut preview = GpuPreview::open(
        ctx,
        &source.raw,
        &source.bytes,
        &source.ext,
        decode_model,
        edge,
    )
    .unwrap();
    let uploads = preview.upload_count();
    let mut allocations = None;
    let mut worst = 0u8;
    for (target, white_balance) in targets(&preview.creative.header) {
        let model = at(decode_model, white_balance);
        let (live, refine) = (
            shown(&mut preview, ctx, source, &model),
            source.refined(&model, edge),
        );
        let step = max_step(&live, &refine);
        let moved = live.iter().zip(&refine).filter(|(a, b)| a != b).count();
        eprintln!(
            "linux {name} @ {target}: max step {step}, {moved}/{} channels differ",
            live.len()
        );
        assert!(step <= 1, "{name} @ {target}: {step} steps");
        worst = worst.max(step);
        assert!(preview.profile.inputs.creative.is_some());
        let count = preview.pool_alloc_count(ctx);
        assert_eq!(
            *allocations.get_or_insert(count),
            count,
            "{name} @ {target}"
        );
    }
    assert_eq!(preview.upload_count(), uploads, "a drag must not re-decode");
    worst
}

#[test]
fn a_white_balance_drag_matches_the_develop_on_a_committed_raw() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let source = Source::read(&path);
    let ctx = GpuContext::new_blocking().unwrap();
    for (name, model) in combinations() {
        drag(&ctx, &source, name, &model, 256);
    }
}

fn gate(name: &str) {
    let source = Source::read(&raw_core::test_support::fixtures::require_raw(name));
    let ctx = GpuContext::new_blocking().unwrap();
    let worst = combinations()
        .iter()
        .map(|(combination, model)| {
            drag(
                &ctx,
                &source,
                &format!("{name} [{combination}]"),
                model,
                EDGE,
            )
        })
        .max()
        .unwrap_or(0);
    eprintln!("linux {name}: worst live-vs-refine step {worst}");
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0005() {
    gate(FIXTURES[0]);
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0007() {
    gate(FIXTURES[1]);
}
