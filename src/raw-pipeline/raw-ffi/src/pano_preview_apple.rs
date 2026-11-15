use std::path::{Path, PathBuf};

use maple_pano::render::{write_frame_png, PngMetadata};
use maple_pano::stitch::{preview, StitchOptions};

use crate::cancel::SendCancelPtr;
use crate::error::set_last_error;

use super::super::pano_apple::{
    cancel_adapter, error_rc, progress_adapter, read_alignment, reuse_rc,
};
use super::super::SendProgressCallback;

const NAME: &str = "maple_pano_preview";

pub(super) fn run_preview(
    input_paths: Vec<String>,
    out_png: String,
    alignment_in: Option<String>,
    alignment_out: Option<String>,
    opts: StitchOptions,
    cb: SendProgressCallback,
    send_cancel: SendCancelPtr,
) -> (
    i32,
    Option<(super::MaplePanoPreviewSizes, super::MaplePanoEdgesReport)>,
) {
    let inputs: Vec<PathBuf> = input_paths.iter().map(PathBuf::from).collect();
    let (offered, unreadable) = read_alignment(alignment_in.as_deref());
    let result = preview(
        &inputs,
        &opts,
        offered.as_ref(),
        progress_adapter(cb),
        cancel_adapter(send_cancel),
    );
    let pv = match result {
        Ok(pv) => pv,
        Err(e) => return (error_rc(NAME, e), None),
    };
    let written = write_frame_png(
        Path::new(&out_png),
        pv.width,
        pv.height,
        &pv.display_rgb16,
        &PngMetadata {
            exif_blob: None,
            tag_srgb: true,
        },
    )
    .map_err(|e| format!("write preview PNG: {e}"))
    .and_then(|()| {
        alignment_out.map_or(Ok(()), |p| {
            std::fs::write(&p, pv.alignment.to_json())
                .map_err(|e| format!("write alignment {p}: {e}"))
        })
    });
    match written {
        Ok(()) => (
            reuse_rc(NAME, &pv.reuse, unreadable),
            Some((
                super::MaplePanoPreviewSizes {
                    full_width: pv.full_canvas_estimate.0,
                    full_height: pv.full_canvas_estimate.1,
                    largest_frame_px: pv.largest_frame_px,
                    scratch_bytes: pv.scratch_bytes,
                },
                super::MaplePanoEdgesReport::from(&pv.edges),
            )),
        ),
        Err(msg) => {
            set_last_error(format!("{NAME}: {msg}"));
            (-7, None)
        }
    }
}
