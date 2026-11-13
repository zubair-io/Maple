//! One shared source-framed selection view, outside interactive grading.
use super::*;

/// Fixed As-Shot source-framed RGB8 (at most 1024 long edge), including the
/// exact verified accepted stack. Creative grade/geometry are excluded. Source
/// coordinates are native unoriented DefaultCrop pixels, as with durable masks.
/// # Safety
/// raw/owner remain live until return; xmp is NUL-terminated UTF-8; output is
/// writable, initially empty and disjoint. Free successful output with the
/// ordinary removal buffer release. Failure leaves the descriptor empty.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_saved_selection_proxy(
    raw: *const MapleRawHandle,
    owner: *const MapleSavedRemovals,
    xmp: *const c_char,
    output: *mut MapleRemovalBuffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    *output = MapleRemovalBuffer::empty();
    let args = (raw as usize, owner as usize, xmp as usize, output as usize);
    with_large_stack(move || {
        let result = (|| {
            let raw = inner(args.0 as *const MapleRawHandle)?;
            let owner = saved(args.1 as *const MapleSavedRemovals)?;
            if owner.original != raw.original {
                return Err("saved-removal RAW owner changed".into());
            }
            let model = match load_xmp_model_from_doc(Some(text(args.2 as *const c_char)?)) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(code) => return Err(format!("saved XMP invalid ({code})")),
            };
            let (width, height, rgb) = raw_core::pipeline::render_removal_selection_proxy(
                &raw.raw,
                &raw.original,
                Some(RawInput::Bytes {
                    bytes: &owner.source,
                    ext: &owner.ext,
                }),
                Some(&owner.stack),
                &model.inpaint_removals,
            )
            .map_err(|error| error.to_string())?;
            Ok(MapleRemovalBuffer::owned(width, height, rgb))
        })();
        match result {
            Ok(buffer) => {
                *(args.3 as *mut MapleRemovalBuffer) = buffer;
                0
            }
            Err(error) => failed(error),
        }
    })
}
