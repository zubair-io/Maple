//! Native saved tiles reuse the full-frame anchors of one bounded base (#3955).
use super::*;
use raw_core::pipeline::{DetailContext, DetailRenderOptions, TileRect};

pub(super) struct PreparedDetail {
    xmp: String,
    cap: u32,
    preview: bool,
    film_bytes: Vec<u8>,
    film: Option<raw_core::film::FilmLut>,
    context: DetailContext,
}

/// Packed sRGB RGB8 native tile in oriented DefaultCrop-relative pixels.
/// Retains one full-frame AE/Whites/Auto context per verified owner, keyed by
/// exact XMP, base cap/quality and MLUT bytes. Pans reuse it without asset I/O
/// or RAW decode. Recipe changes release old anchors before preparing new ones.
/// `cap` is the bounded base render's long edge; zero is invalid. `preview`
/// selects Preview base quality when 1, AMaZE when 0. The native tile always
/// uses the shared core's native Auto quality. `max_working_pixels` includes
/// filter overlap and must be in 1..=8388608. Unsupported geometry/stages fail
/// closed; caller may keep its verified sized preview. 0 success, 1 null
/// output, 5 invalid/budget/unsupported, 98 worker failure, 99 panic.
/// # Safety
/// raw/owner remain live until return; xmp is NUL-terminated UTF-8; film is
/// readable for film_len. output is writable, initially empty and disjoint.
/// Owner may serialize concurrent detail calls but must not close during one.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_removal_saved_detail(
    raw: *const MapleRawHandle,
    owner: *const MapleSavedRemovals,
    xmp: *const c_char,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    cap: u32,
    preview: i32,
    film: *const u8,
    film_len: usize,
    max_working_pixels: u64,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    *output = MapleRemovalBuffer::empty();
    if cap == 0
        || width == 0
        || height == 0
        || !matches!(preview, 0 | 1)
        || !(1..=8 * 1024 * 1024).contains(&max_working_pixels)
    {
        return failed("invalid saved native-detail request".into());
    }
    let args = (
        raw as usize,
        owner as usize,
        xmp as usize,
        film as usize,
        output as usize,
    );
    with_large_stack(move || {
        let result = (|| {
            let raw = inner(args.0 as *const MapleRawHandle)?;
            let owner = saved(args.1 as *const MapleSavedRemovals)?;
            if owner.original != raw.original {
                return Err("saved native-detail RAW owner changed".into());
            }
            let xmp = text(args.2 as *const c_char)?;
            let film_bytes = bytes(args.3 as *const u8, film_len)?;
            let preview = preview == 1;
            let mut prepared = owner
                .detail
                .lock()
                .map_err(|_| "saved native-detail owner poisoned")?;
            let changed = prepared.as_ref().is_none_or(|p| {
                p.xmp != xmp || p.cap != cap || p.preview != preview || p.film_bytes != film_bytes
            });
            if changed {
                *prepared = None;
                let model = match load_xmp_model_from_doc(Some(xmp)) {
                    LoadModel::Ok(model) => model,
                    LoadModel::Err(code) => {
                        return Err(format!("saved detail XMP invalid ({code})"))
                    }
                };
                let film = film_lut(film_bytes)?;
                let (_, _, _, context) = owner
                    .stack
                    .render_detail_base(
                        &raw.raw,
                        &raw.original,
                        &model,
                        RawInput::Bytes {
                            bytes: &owner.source,
                            ext: &owner.ext,
                        },
                        DetailRenderOptions {
                            quality: if preview {
                                RenderQuality::Preview
                            } else {
                                RenderQuality::Amaze
                            },
                            max_long_edge: cap,
                            film_lut: film.as_ref(),
                        },
                    )
                    .map_err(|e| e.to_string())?;
                *prepared = Some(PreparedDetail {
                    xmp: xmp.to_owned(),
                    cap,
                    preview,
                    film_bytes: film_bytes.to_vec(),
                    film,
                    context,
                });
            }
            let prepared = prepared
                .as_ref()
                .ok_or("saved native-detail anchors missing")?;
            let (w, h, rgb) = owner
                .stack
                .render_detail_tile(
                    &raw.raw,
                    &raw.original,
                    &prepared.context,
                    TileRect {
                        src_x: x,
                        src_y: y,
                        src_w: width,
                        src_h: height,
                        out_w: width,
                        out_h: height,
                    },
                    prepared.film.as_ref(),
                    max_working_pixels,
                )
                .map_err(|e| e.to_string())?;
            Ok(MapleRemovalBuffer::owned(w, h, rgb))
        })();
        match result {
            Ok(buffer) => {
                *(args.4 as *mut MapleRemovalBuffer) = buffer;
                0
            }
            Err(e) => failed(e),
        }
    })
}
