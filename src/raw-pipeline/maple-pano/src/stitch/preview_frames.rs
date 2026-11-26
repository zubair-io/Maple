//! Stage 0 for the preview, which needs no full-resolution frames: every
//! frame to its long-edge proxy and priors, developed band by band
//! ([`ProxyDevelop`]) or read back from [`StitchOptions::proxy_cache_dir`].

use std::path::PathBuf;

use crate::frame_store::ProxyDevelop;
use crate::ingest::FrameMeta;

use super::frames::{input_dims, store_error, BAND_ROWS};
use super::proxy_cache::ProxyCache;
use super::{StitchError, StitchOptions};

pub(super) fn decode_proxies(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<FrameMeta>, StitchError> {
    progress(0, 0.0);
    let edge = opts.proxy_long_edge;
    let cache = opts.proxy_cache_dir.as_deref().map(ProxyCache::new);
    if let Some(cache) = &cache {
        cache.retain_only(inputs, edge);
    }
    let mut develop: Option<ProxyDevelop> = None;
    let mut metas = Vec::with_capacity(inputs.len());
    for (i, path) in inputs.iter().enumerate() {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        let cached = cache.as_ref().and_then(|c| c.load(path, edge));
        let meta = match cached {
            Some(meta) => meta,
            None => {
                let developer = match &mut develop {
                    Some(developer) => developer,
                    slot @ None => slot.insert(open_develop(inputs)?),
                };
                let meta = developer
                    .develop(path, BAND_ROWS, edge)
                    .map_err(|e| store_error(path, e))?;
                if let Some(cache) = &cache {
                    cache.store(path, edge, &meta);
                }
                meta
            }
        };
        metas.push(meta);
        progress(0, (i + 1) as f32 / inputs.len() as f32);
    }
    Ok(metas)
}

/// A develop in the system temp directory sized for the largest input.
fn open_develop(inputs: &[PathBuf]) -> Result<ProxyDevelop, StitchError> {
    let largest = input_dims(inputs)?
        .into_iter()
        .max_by_key(|&(w, h)| w as u64 * h as u64)
        .unwrap_or((0, 0));
    let parent = std::env::temp_dir();
    ProxyDevelop::create(&parent, largest).map_err(|e| store_error(&parent, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ingest_file_proxy;
    use raw_core::test_support::synth_dng::SyntheticGreyDng;

    fn frames(dir: &std::path::Path) -> Vec<PathBuf> {
        [
            (None, None),
            (Some(6), Some([4, 2, 150, 90])),
            (Some(3), None),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (orientation, default_crop))| {
            let path = dir.join(format!("f{i}.dng"));
            SyntheticGreyDng {
                linear_value: 0.1 + 0.2 * i as f32,
                width: 160,
                height: 100,
                orientation,
                default_crop,
                ..SyntheticGreyDng::default()
            }
            .write_to(&path)
            .expect("write DNG");
            path
        })
        .collect()
    }

    fn assert_same(got: &FrameMeta, want: &FrameMeta) {
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(
            (
                got.proxy.width(),
                got.proxy.height(),
                got.full_width,
                got.full_height
            ),
            (
                want.proxy.width(),
                want.proxy.height(),
                want.full_width,
                want.full_height
            )
        );
        assert_eq!(bits(&got.proxy.r), bits(&want.proxy.r));
        assert_eq!(bits(&got.proxy.g), bits(&want.proxy.g));
        assert_eq!(bits(&got.proxy.b), bits(&want.proxy.b));
        assert_eq!(got.proxy_scale_x.to_bits(), want.proxy_scale_x.to_bits());
        assert_eq!(got.proxy_scale_y.to_bits(), want.proxy_scale_y.to_bits());
        assert_eq!(got.priors, want.priors);
        assert_eq!(got.applied_opcodes, want.applied_opcodes);
        assert_eq!(got.falloff_correction, want.falloff_correction);
    }

    #[test]
    fn banded_proxies_match_the_full_frame_ingest_and_the_cache_returns_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = frames(dir.path());
        let opts = StitchOptions {
            proxy_long_edge: 48,
            proxy_cache_dir: Some(dir.path().join("cache")),
            ..StitchOptions::default()
        };
        let want: Vec<FrameMeta> = inputs
            .iter()
            .map(|p| ingest_file_proxy(p, opts.proxy_long_edge).expect("full-frame ingest"))
            .collect();
        let developed = decode_proxies(&inputs, &opts, &mut |_, _| {}, &|| false).expect("develop");
        let cached = decode_proxies(&inputs, &opts, &mut |_, _| {}, &|| false).expect("cache");
        for ((got, again), want) in developed.iter().zip(&cached).zip(&want) {
            assert_same(got, want);
            assert_same(again, want);
        }
        let cache_files = std::fs::read_dir(dir.path().join("cache"))
            .expect("cache dir")
            .count();
        assert_eq!(cache_files, inputs.len());
    }

    #[test]
    fn a_cancelled_preview_stops_before_the_next_frame() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = frames(dir.path());
        let result = decode_proxies(&inputs, &StitchOptions::default(), &mut |_, _| {}, &|| true);
        assert!(matches!(result, Err(StitchError::Cancelled)));
    }
}
