//! Capture decode entries (#5377) with and without a saved removal stack.
use super::{stage, FIXTURE};
use crate::{
    capture_base::{
        maple_free_capture_base, maple_render_bytes_capture_base_f32,
        maple_render_file_capture_base_f32, tests::empty, tests::pixels, MapleCaptureBase,
    },
    capture_creative::{maple_free_capture_buffer_f32, MapleCaptureBufferF32},
    capture_f32::{
        maple_render_bytes_capture_f32, maple_render_bytes_capture_sized_f32,
        maple_render_file_capture_f32, maple_render_file_capture_sized_f32,
        maple_render_handle_capture_tile_f32,
    },
    handle::{maple_close_raw_handle, maple_open_raw_handle},
};
use raw_core::pipeline::{RenderQuality, TileRect};
use std::{ffi::CString, path::Path};

const QUALITY: i32 = 3;
const PATCH: (std::ops::Range<usize>, std::ops::Range<usize>) = (4..12, 2..6);

#[derive(Clone, Copy, Debug)]
enum Entry {
    File,
    FileSized,
    FileBase,
    Bytes,
    BytesSized,
    BytesBase,
}

const ENTRIES: [Entry; 6] = [
    Entry::File,
    Entry::FileSized,
    Entry::FileBase,
    Entry::Bytes,
    Entry::BytesSized,
    Entry::BytesBase,
];

impl Entry {
    fn edge(self) -> Option<u32> {
        match self {
            Entry::FileSized | Entry::BytesSized => Some(16),
            _ => None,
        }
    }

    /// The return code and, on success, the capture pixels; a base entry
    /// must also hand back a base exactly when it succeeds.
    fn run(self, raw: &CString, source: &[u8], xmp: *const std::ffi::c_char) -> (i32, Vec<f32>) {
        let ext = CString::new("dng").unwrap();
        let mut out = empty();
        let mut base: *mut MapleCaptureBase = std::ptr::null_mut();
        let (bytes, len) = (source.as_ptr(), source.len());
        let never = std::ptr::null();
        let rc = unsafe {
            match self {
                Entry::File => {
                    maple_render_file_capture_f32(raw.as_ptr(), xmp, QUALITY, never, &mut out)
                }
                Entry::FileSized => maple_render_file_capture_sized_f32(
                    raw.as_ptr(),
                    xmp,
                    16,
                    QUALITY,
                    never,
                    &mut out,
                ),
                Entry::FileBase => maple_render_file_capture_base_f32(
                    raw.as_ptr(),
                    xmp,
                    0,
                    QUALITY,
                    never,
                    &mut out,
                    &mut base,
                ),
                Entry::Bytes => maple_render_bytes_capture_f32(
                    bytes,
                    len,
                    ext.as_ptr(),
                    xmp,
                    QUALITY,
                    never,
                    &mut out,
                ),
                Entry::BytesSized => maple_render_bytes_capture_sized_f32(
                    bytes,
                    len,
                    ext.as_ptr(),
                    xmp,
                    16,
                    QUALITY,
                    never,
                    &mut out,
                ),
                Entry::BytesBase => maple_render_bytes_capture_base_f32(
                    bytes,
                    len,
                    ext.as_ptr(),
                    xmp,
                    0,
                    QUALITY,
                    never,
                    &mut out,
                    &mut base,
                ),
            }
        };
        assert_eq!(
            rc == 0 && matches!(self, Entry::FileBase | Entry::BytesBase),
            !base.is_null()
        );
        let result = if rc == 0 { pixels(&out) } else { Vec::new() };
        if rc != 0 {
            assert!(
                out.scene.f32_rgba.is_null(),
                "{self:?} wrote a failed capture"
            );
        }
        unsafe {
            maple_free_capture_base(base);
            maple_free_capture_buffer_f32(&mut out as *mut MapleCaptureBufferF32);
        }
        (rc, result)
    }
}

fn patched(index: usize, width: usize) -> bool {
    let (x, y) = (index % width, index / width);
    PATCH.0.contains(&x) && PATCH.1.contains(&y)
}

#[test]
fn every_capture_entry_returns_the_verified_saved_stack() {
    let (directory, raw_path, xmp, source) = stage();
    let model =
        raw_core::xmp::parse(&std::fs::read_to_string(xmp.to_str().unwrap()).unwrap()).unwrap();
    let raw = raw_core::decode_raw(&source, "dng").unwrap();
    let (saved, original) =
        crate::removal_file::prepare_saved(&raw, &source, &model, Some(directory.path()))
            .unwrap()
            .unwrap();
    let unedited = raw_core::xmp::AdjustmentModel::default();
    for entry in ENTRIES {
        let expected = saved
            .render_capture(
                &raw,
                &original,
                &model,
                RenderQuality::Auto,
                entry.edge(),
                raw_core::CancelToken::never(),
            )
            .unwrap();
        let (rc, actual) = entry.run(&raw_path, &source, xmp.as_ptr());
        assert_eq!(rc, 0, "{entry:?}");
        assert_eq!(actual, expected.rgba, "{entry:?}");
        let never = raw_core::CancelToken::never();
        let plain = match entry.edge() {
            Some(edge) => raw_core::pipeline::render_capture_sized_from_raw_f32(
                &raw,
                &unedited,
                RenderQuality::Auto,
                edge,
                never,
            ),
            None => raw_core::pipeline::render_capture_from_raw_f32(
                &raw,
                &unedited,
                RenderQuality::Auto,
                never,
            ),
        }
        .unwrap();
        let width = expected.width as usize;
        let (mut inside, mut outside) = (0, 0);
        for (index, (a, b)) in actual.chunks(4).zip(plain.rgba.chunks(4)).enumerate() {
            if patched(index, width) {
                inside += usize::from(a != b);
            } else {
                outside += usize::from(a != b);
            }
        }
        assert_eq!(inside, PATCH.0.len() * PATCH.1.len(), "{entry:?}");
        assert_eq!(outside, 0, "{entry:?}");
    }
}

#[test]
fn capture_entries_without_records_are_main_bytes() {
    let (directory, raw_path, _, source) = stage();
    let plain = directory.path().join("plain.xmp");
    std::fs::write(
        &plain,
        "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" \
         xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"0.5\"/>",
    )
    .unwrap();
    let plain = CString::new(plain.to_str().unwrap()).unwrap();
    let raw = raw_core::decode_raw(&source, "dng").unwrap();
    let loaded = match crate::model::load_xmp_model_owned(plain.to_str().ok()) {
        crate::model::LoadModel::Ok(model) => model,
        crate::model::LoadModel::Err(rc) => panic!("sidecar rc {rc}"),
    };
    assert!(loaded.inpaint_removals.is_empty());
    let model = crate::model::force_ae_off_if_auto_will_fit_bytes(&loaded, &source, "dng");
    let never = raw_core::CancelToken::never;
    for entry in ENTRIES {
        let expected = match entry {
            Entry::FileBase | Entry::BytesBase => {
                raw_core::pipeline::render_capture_with_base_from_raw_f32(
                    &raw,
                    (&loaded, &model),
                    RenderQuality::Auto,
                    None,
                    never(),
                )
                .unwrap()
                .0
            }
            _ => match entry.edge() {
                Some(edge) => raw_core::pipeline::render_capture_sized_from_raw_f32(
                    &raw,
                    &model,
                    RenderQuality::Auto,
                    edge,
                    never(),
                ),
                None => raw_core::pipeline::render_capture_from_raw_f32(
                    &raw,
                    &model,
                    RenderQuality::Auto,
                    never(),
                ),
            }
            .unwrap(),
        };
        for xmp in [plain.as_ptr(), std::ptr::null()] {
            let (rc, actual) = entry.run(&raw_path, &source, xmp);
            assert_eq!(rc, 0, "{entry:?}");
            if !xmp.is_null() {
                assert_eq!(actual, expected.rgba, "{entry:?}");
            }
        }
    }
}

#[test]
fn missing_corrupt_or_changed_inputs_fail_every_capture_entry_closed() {
    for failure in ["missing", "corrupt", "changed"] {
        let (directory, raw_path, xmp, source) = stage();
        let mask = raw_core::types::accepted_removal::ContentDigest::for_bytes(
            &std::fs::read(Path::new(FIXTURE).join("mask.mimf")).unwrap(),
        );
        let mask_path = directory
            .path()
            .join(".maple/inpaint")
            .join(format!("{}.mask", mask.hex()));
        let source = match failure {
            "missing" => {
                std::fs::remove_file(mask_path).unwrap();
                source
            }
            "corrupt" => {
                std::fs::write(mask_path, b"corrupt").unwrap();
                source
            }
            _ => {
                let mut changed = source;
                changed.push(0);
                std::fs::write(raw_path.to_str().unwrap(), &changed).unwrap();
                changed
            }
        };
        for entry in ENTRIES {
            assert_eq!(
                entry.run(&raw_path, &source, xmp.as_ptr()).0,
                8,
                "{failure} {entry:?}"
            );
        }
    }
}

#[test]
fn a_saved_handle_renders_capture_tiles_from_its_retained_stack() {
    let (directory, raw_path, xmp, source) = stage();
    let model =
        raw_core::xmp::parse(&std::fs::read_to_string(xmp.to_str().unwrap()).unwrap()).unwrap();
    let raw = raw_core::decode_raw(&source, "dng").unwrap();
    let (saved, original) =
        crate::removal_file::prepare_saved(&raw, &source, &model, Some(directory.path()))
            .unwrap()
            .unwrap();
    let mut handle = std::ptr::null_mut();
    unsafe {
        assert_eq!(
            maple_open_raw_handle(raw_path.as_ptr(), xmp.as_ptr(), &mut handle),
            0
        );
        std::fs::remove_dir_all(directory.path().join(".maple/inpaint")).unwrap();
        std::fs::remove_file(xmp.to_str().unwrap()).unwrap();
        for x in [0, 3] {
            let rect = TileRect {
                src_x: x,
                src_y: 2,
                src_w: 8,
                src_h: 4,
                out_w: 8,
                out_h: 4,
            };
            let expected = saved
                .render_capture_tile_f32(&raw, &original, &model, rect, RenderQuality::Full)
                .unwrap();
            let unpatched = raw_core::pipeline::render_capture_tile_cancellable_f32(
                &raw,
                &raw_core::xmp::AdjustmentModel::default(),
                rect,
                RenderQuality::Full,
                raw_core::CancelToken::never(),
            )
            .unwrap();
            assert_ne!(expected.2, unpatched.2);
            let mut out = crate::buffers::MapleSceneLinearBufferF32::empty();
            let rc = maple_render_handle_capture_tile_f32(handle, x, 2, 8, 4, 8, 4, 0, &mut out);
            assert_eq!(rc, 0);
            assert_eq!((out.width, out.height), (expected.0, expected.1));
            assert_eq!(
                std::slice::from_raw_parts(out.f32_rgba, out.len_bytes / 4),
                expected.2.as_slice()
            );
            crate::buffers::maple_free_scene_linear_buffer_f32(&mut out);
        }
        maple_close_raw_handle(handle);
    }
}
