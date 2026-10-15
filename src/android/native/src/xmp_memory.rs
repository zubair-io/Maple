//! Test-only allocator witness: opaque XMP must not create a DOM/full-document clone.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

struct Tracking;
#[global_allocator]
static ALLOCATOR: Tracking = Tracking;

fn account(added: usize, removed: usize) {
    let _ = ACTIVE.try_with(|enabled| {
        if enabled.get() {
            LIVE.with(|live| {
                let next = live.get().saturating_sub(removed).saturating_add(added);
                live.set(next);
                PEAK.with(|peak| peak.set(peak.get().max(next)));
            });
        }
    });
}

unsafe impl GlobalAlloc for Tracking {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            account(layout.size(), 0);
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            account(layout.size(), 0);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        account(0, layout.size());
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, size) };
        if !result.is_null() {
            account(size, layout.size());
        }
        result
    }
}

struct Window;
impl Drop for Window {
    fn drop(&mut self) {
        ACTIVE.with(|active| active.set(false));
    }
}

#[test]
fn dense_opaque_sidecar_uses_bounded_import_scratch() {
    let mut source = String::from(
        r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:m="https://maple.app/ns/1.0/" xmlns:f="urn:foreign"><r:Description c:Exposure2012="0.75" c:Temperature="6000" c:Tint="5"><f:opaque>"#,
    );
    let node = r#"<f:i f:v="&amp;">&lt;opaque&gt;</f:i>"#;
    for _ in 0..32 * 1024 * 1024 / node.len() {
        source.push_str(node);
    }
    source.push_str("</f:opaque><m:SceneLinearToneCurve><r:Seq><r:li>0, 0</r:li><r:li>255, 230</r:li></r:Seq></m:SceneLinearToneCurve></r:Description></r:RDF>");
    // The source is already owned by JNI in production; measure only parser scratch.
    LIVE.with(|live| live.set(0));
    PEAK.with(|peak| peak.set(0));
    ACTIVE.with(|active| active.set(true));
    let window = Window;
    let parsed = super::parse(&source);
    let peak = PEAK.with(Cell::get);
    drop(window);
    let model = parsed.unwrap();
    eprintln!("32 MiB opaque XMP: {peak} peak scratch bytes");
    assert_eq!(model.exposure, 0.75);
    assert_eq!(model.temperature, 6000.0);
    assert_eq!(
        model.wb_scale_version,
        raw_core::types::adjustment::WbScaleVersion::V1
    );
    assert_eq!(model.tone_curve_luma.points.len(), 2);
    assert!(
        peak < 8 * 1024 * 1024,
        "32 MiB dense opaque XMP required {peak} scratch bytes"
    );
}
