//! The placeholder's `CAMetalLayer` present (#5758): the same cached surface,
//! reservation and settle double-present as the live chain's, with the
//! placeholder still as the pass's source.

use super::{with_reserved_frame, PersistentPresentSurface, PresentSource};
use crate::context::GpuContext;
use crate::present_chain_pipeline::PresentGeometry;
use crate::present_placeholder::PlaceholderSource;
use std::ffi::c_void;

/// Present `source` into `layer` at `surface`. Returns `Ok(false)` when
/// `cancel` was set before the drawable was presented. Shares `cache` with
/// [`super::present_chain_to_surface`], so the live chain's first frame
/// presents into the same surface, replacing the placeholder in one
/// drawable; a failed present clears the cache as the chain's does.
///
/// # Safety
/// As [`super::present_chain_to_surface`]: `layer` is a valid `CAMetalLayer*`
/// that outlives `cache`.
pub unsafe fn present_placeholder_to_surface(
    ctx: &GpuContext,
    source: &PlaceholderSource,
    layer: *mut c_void,
    cache: &mut Option<PersistentPresentSurface>,
    generation: u64,
    surface: (u32, u32),
    cancel: &crate::CancelToken,
) -> Result<bool, String> {
    if cancel.is_cancelled() {
        return Ok(false);
    }
    let just_configured = PersistentPresentSurface::ensure(ctx, layer, cache, generation, surface)?;
    let target = cache.as_ref().expect("populated above");
    let present = |frame| {
        let source = PresentSource {
            buffer: source.buffer(),
            identity: (source.identity(), 0),
            dims: source.dims(),
            histogram: None,
        };
        target.present_reserved_source(ctx, source, PresentGeometry::IDENTITY, frame);
    };
    let result = with_reserved_frame(
        cancel,
        || target.acquire(),
        |frame| {
            present(frame);
            if just_configured {
                present(target.acquire()?);
            }
            Ok(!cancel.is_cancelled())
        },
    );
    if result.is_err() {
        *cache = None;
    }
    result
}
