use super::*;
use crate::removal_inference::{maple_removal_inference_cancel, maple_removal_inference_free};
use std::{ffi::CString, fs};

#[test]
fn invalid_selection_and_detector_boundaries_publish_no_owned_output() {
    unsafe {
        let mut selector = 1usize as *mut MapleRemovalSelector;
        assert_eq!(
            maple_removal_selector_open(std::ptr::null(), std::ptr::null(), &mut selector),
            5
        );
        assert!(selector.is_null());
        let mut detector = 1usize as *mut MapleRemovalDetector;
        assert_eq!(
            maple_removal_detector_open(std::ptr::null(), std::ptr::null(), &mut detector),
            5
        );
        assert!(detector.is_null());
        let mut op = 1usize as *mut MapleRemovalInference;
        assert_eq!(
            maple_removal_selector_operation_new(std::ptr::null(), &mut op),
            5
        );
        assert!(op.is_null());
        assert_eq!(
            maple_removal_detector_operation_new(std::ptr::null(), &mut op),
            5
        );
        assert!(op.is_null());
        let mut embedding = 1usize as *mut MapleRemovalEmbedding;
        assert_eq!(
            maple_removal_selector_encode(
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut embedding
            ),
            5
        );
        assert!(embedding.is_null());
        let mut buffer = MapleRemovalBuffer::empty();
        assert_eq!(
            maple_removal_selector_refine(
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut buffer
            ),
            5
        );
        assert!(buffer.bytes.is_null());
        assert_eq!(buffer.len, 0);
        assert_eq!(
            maple_removal_detector_detect(
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                0,
                0,
                &mut buffer
            ),
            5
        );
        assert!(buffer.bytes.is_null());
        assert_eq!(buffer.len, 0);
        maple_removal_embedding_free(std::ptr::null_mut());
        maple_removal_selector_close(std::ptr::null_mut());
        maple_removal_detector_close(std::ptr::null_mut());
    }
}

struct Selector(*mut MapleRemovalSelector);
impl Drop for Selector {
    fn drop(&mut self) {
        unsafe {
            maple_removal_selector_close(self.0);
        }
    }
}
struct Detector(*mut MapleRemovalDetector);
impl Drop for Detector {
    fn drop(&mut self) {
        unsafe {
            maple_removal_detector_close(self.0);
        }
    }
}
struct Op(*mut MapleRemovalInference);
impl Drop for Op {
    fn drop(&mut self) {
        unsafe {
            maple_removal_inference_free(self.0);
        }
    }
}
struct Emb(*mut MapleRemovalEmbedding);
impl Drop for Emb {
    fn drop(&mut self) {
        unsafe {
            maple_removal_embedding_free(self.0);
        }
    }
}
struct Output(MapleRemovalBuffer);
impl Drop for Output {
    fn drop(&mut self) {
        unsafe {
            crate::maple_removal_saved_free_buffer(&mut self.0);
        }
    }
}
impl Output {
    fn new() -> Self {
        Self(MapleRemovalBuffer::empty())
    }
    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.0.bytes, self.0.len) }
    }
}

// Explicit local corpus, never downloads. CI absence is an ignore, not quality
// evidence. Symlink pinned artifacts/reference inputs into this fixture folder.
#[test]
#[ignore = "requires pinned native selection models/runtime and real RAW contexts (#3941)"]
fn real_native_selection_and_detection_match_references_and_reject_stale_or_cancelled_work() {
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws/removal-inference");
    let directory = CString::new(root.to_str().unwrap()).unwrap();
    let runtime = CString::new(root.join("runtime.dylib").to_str().unwrap()).unwrap();
    let context: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("selection-context.json")).unwrap()).unwrap();
    let anchor = CString::new(context["source_anchor"].to_string()).unwrap();
    let request =
        CString::new(fs::read_to_string(root.join("selection-request.json")).unwrap()).unwrap();
    let image = image::open(root.join("selection-input.png"))
        .unwrap()
        .to_rgb8();
    assert_eq!(image.dimensions(), (1024, 1024));
    let rgb: Vec<f32> = (0..3)
        .flat_map(|c| image.pixels().map(move |p| f32::from(p[c])))
        .collect();
    unsafe {
        let mut model = std::ptr::null_mut();
        assert_eq!(
            maple_removal_selector_open(directory.as_ptr(), runtime.as_ptr(), &mut model),
            0
        );
        let model = Selector(model);
        let mut op = std::ptr::null_mut();
        assert_eq!(maple_removal_selector_operation_new(model.0, &mut op), 0);
        let op = Op(op);
        let mut embedding = std::ptr::null_mut();
        assert_eq!(
            maple_removal_selector_encode(
                model.0,
                op.0,
                anchor.as_ptr(),
                request.as_ptr(),
                rgb.as_ptr(),
                rgb.len(),
                &mut embedding
            ),
            0
        );
        let embedding = Emb(embedding);
        let mut mask = Output::new();
        assert_eq!(
            maple_removal_selector_refine(
                model.0,
                op.0,
                embedding.0,
                anchor.as_ptr(),
                request.as_ptr(),
                &mut mask.0
            ),
            0
        );
        assert_eq!(
            mask.bytes(),
            fs::read(root.join("selection-reference.mimf")).unwrap()
        );
        let mut stale = context["source_anchor"].clone();
        stale["original"] =
            raw_core::types::accepted_removal::ContentDigest::for_bytes(b"different original")
                .as_str()
                .into();
        let stale = CString::new(stale.to_string()).unwrap();
        let mut output = Output::new();
        assert_eq!(
            maple_removal_selector_refine(
                model.0,
                op.0,
                embedding.0,
                stale.as_ptr(),
                request.as_ptr(),
                &mut output.0
            ),
            5
        );
        assert!(output.0.bytes.is_null());
        maple_removal_inference_cancel(op.0);
        assert_eq!(
            maple_removal_selector_refine(
                model.0,
                op.0,
                embedding.0,
                anchor.as_ptr(),
                request.as_ptr(),
                &mut output.0
            ),
            20
        );
        assert!(output.0.bytes.is_null());
        let mut rejected = std::ptr::null_mut();
        assert_eq!(
            maple_removal_selector_encode(
                model.0,
                op.0,
                anchor.as_ptr(),
                request.as_ptr(),
                rgb.as_ptr(),
                rgb.len(),
                &mut rejected
            ),
            20
        );
        assert!(rejected.is_null());

        let mut detector = std::ptr::null_mut();
        assert_eq!(
            maple_removal_detector_open(directory.as_ptr(), runtime.as_ptr(), &mut detector),
            0
        );
        let detector = Detector(detector);
        let mut op = std::ptr::null_mut();
        assert_eq!(maple_removal_detector_operation_new(detector.0, &mut op), 0);
        let op = Op(op);
        let bytes = fs::read(root.join("detection-input.f32")).unwrap();
        let rgb: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        let meta: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("detection-input.json")).unwrap()).unwrap();
        let size: [u32; 2] = serde_json::from_value(meta["size"].clone()).unwrap();
        let mut detections = Output::new();
        assert_eq!(
            maple_removal_detector_detect(
                detector.0,
                op.0,
                rgb.as_ptr(),
                rgb.len(),
                size[0],
                size[1],
                &mut detections.0
            ),
            0
        );
        let actual: serde_json::Value = serde_json::from_slice(detections.bytes()).unwrap();
        let expected: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("detection-reference.json")).unwrap())
                .unwrap();
        assert_eq!(actual, expected);
        maple_removal_inference_cancel(op.0);
        assert_eq!(
            maple_removal_detector_detect(
                detector.0,
                op.0,
                rgb.as_ptr(),
                rgb.len(),
                size[0],
                size[1],
                &mut output.0
            ),
            20
        );
        assert!(output.0.bytes.is_null());
    }
}
