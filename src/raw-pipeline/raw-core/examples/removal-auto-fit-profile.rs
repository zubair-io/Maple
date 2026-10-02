//! #1472: measure one uncached Auto fit at AMaZE quality and report artifact
//! digests. Run each cap in a fresh process under `/usr/bin/time -l` for RSS.
//! Usage: removal-auto-fit-profile ORIGINAL_RAW proxy|native|prepared
//! Native is a diagnostic control; this does not change the production fit
//! policy or qualify complete-editor latency, memory or photographic quality.
//! Reads the original only and verifies its digest after fitting.
use raw_core::pipeline::{
    fit_auto_profile_from_raw_at_cap, fit_native_auto_profile_cancellable, FitCap, RawInput,
    RenderQuality,
};
use raw_core::xmp::AdjustmentModel;
use std::{path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Expected RAW and proxy|native|prepared".into());
    }
    let path = PathBuf::from(&args[0]);
    let cap = match args[1].to_str() {
        Some("proxy") => FitCap::Proxy,
        Some("native") | Some("prepared") => FitCap::Native,
        _ => return Err("Expected proxy|native|prepared".into()),
    };
    let bytes = std::fs::read(&path)?;
    let source_digest = blake3::hash(&bytes).to_hex().to_string();
    let start = Instant::now();
    let raw = raw_core::decode::decode_bytes(
        &bytes,
        path.extension().and_then(|s| s.to_str()).unwrap_or(""),
    )?;
    let decode_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let prepared = args[1].to_str() == Some("prepared");
    let (curve, residual) = if prepared {
        fit_native_auto_profile_cancellable(
            &raw,
            &AdjustmentModel::default(),
            RenderQuality::Amaze,
            RawInput::Path(&path),
            raw_core::CancelToken::never(),
        )?
    } else {
        fit_auto_profile_from_raw_at_cap(
            &raw,
            &AdjustmentModel::default(),
            RenderQuality::Amaze,
            RawInput::Path(&path),
            cap,
        )
    }
    .ok_or("No Auto fit")?;
    let fit_ms = start.elapsed().as_secs_f64() * 1000.0;
    let warm_ms = if prepared {
        let edited = AdjustmentModel {
            exposure: 3.0,
            contrast: 40.0,
            ..AdjustmentModel::default()
        };
        let start = Instant::now();
        let warm = fit_native_auto_profile_cancellable(
            &raw,
            &edited,
            RenderQuality::Amaze,
            RawInput::Path(&path),
            raw_core::CancelToken::never(),
        )?
        .ok_or("No cached native Auto fit")?;
        assert_eq!(
            warm,
            (curve.clone(), residual.clone()),
            "Edit-dependent native artifacts"
        );
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let flag = std::sync::atomic::AtomicBool::new(true);
        assert!(matches!(
            fit_native_auto_profile_cancellable(
                &raw,
                &edited,
                RenderQuality::Amaze,
                RawInput::Path(&path),
                raw_core::CancelToken::new(&flag),
            ),
            Err(raw_core::Error::Cancelled)
        ));
        Some(ms)
    } else {
        None
    };
    let digest = |lanes: &[f32]| {
        let bytes: Vec<_> = lanes.iter().flat_map(|v| v.to_le_bytes()).collect();
        blake3::hash(&bytes).to_hex().to_string()
    };
    let curve_digest = curve.as_ref().map(|c| digest(&c.to_flat()));
    let residual_digest = residual.as_ref().map(|r| digest(&r.data));
    if blake3::hash(&std::fs::read(&path)?).to_hex().as_str() != source_digest {
        return Err("Original RAW changed".into());
    }
    println!(
        "MAPLE_NATIVE_FIT_PROFILE {}",
        serde_json::json!({"sensorWidth":raw.width,"sensorHeight":raw.height,"quality":"amaze","cap":args[1].to_str(),"decodeMs":decode_ms,"fitMs":fit_ms,"warmMs":warm_ms,"sourceDigest":source_digest,"curveDigest":curve_digest,"residualDigest":residual_digest})
    );
    Ok(())
}
