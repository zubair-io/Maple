//! Wall times of the C entry points the apps and the server call per photo:
//! the embedded 1280 px camera preview and 512 px grid thumb, the server's
//! develop fallback for a RAW without an extractable preview, the full-size
//! JPEG export (default and edited sidecar), and the 512 px thumbnail of an
//! edited photo (export recipe at 512, then the raster AVIF thumb, as
//! `renderRawSidecarDerivative` runs it). Each case prints min and median of
//! `runs` and a digest of the bytes written, so two builds can be compared
//! for both speed and output identity.
//!
//! cargo run --release -p raw-ffi --example ffi-perf -- <RAW> [runs] [case-substring]
use std::ffi::{c_char, CString};
use std::path::{Path, PathBuf};
use std::time::Instant;

use raw_ffi as _;

extern "C" {
    fn maple_render_thumbnail_avif_to_file(
        raw_path: *const c_char,
        out_path: *const c_char,
        max_px: u32,
        quality: u8,
    ) -> i32;
    fn maple_render_thumbnail_preview_jpeg_to_file(
        raw_path: *const c_char,
        out_path: *const c_char,
        max_px: u32,
        quality: u8,
    ) -> i32;
    fn maple_render_develop_jpeg_to_file(
        raw_path: *const c_char,
        xmp_path: *const c_char,
        max_px: u32,
        quality: u8,
        out_path: *const c_char,
    ) -> i32;
    fn maple_export_recipe_to_file(
        raw_path: *const c_char,
        xmp_xml: *const c_char,
        recipe_json: *const c_char,
        film_path: *const c_char,
        out_path: *const c_char,
    ) -> i32;
}

const EDITED_XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="0.40" crs:Contrast2012="15" crs:Highlights2012="-40"
   crs:Shadows2012="35" crs:Whites2012="10" crs:Blacks2012="-8"
   crs:Vibrance="20" crs:Saturation="8" crs:Clarity2012="18" crs:Texture="12"
   crs:Dehaze="10" crs:LuminanceSmoothing="20" crs:PostCropVignetteAmount="-20"
   crs:GrainAmount="15" crs:HueAdjustmentOrange="8" crs:SaturationAdjustmentBlue="15"
   crs:LuminanceAdjustmentGreen="-10" crs:ColorGradeMidtoneHue="40"
   crs:ColorGradeMidtoneSat="12" crs:SplitToningHighlightHue="50"
   crs:SplitToningHighlightSaturation="10"/>
 </rdf:RDF>
</x:xmpmeta>"#;

type Case<'a> = (&'static str, PathBuf, Box<dyn Fn(&CString) -> i32 + 'a>);

fn recipe(max_long_edge: Option<u32>, quality: u32) -> CString {
    let edge = max_long_edge.map_or("null".to_string(), |e| e.to_string());
    CString::new(format!(
        r#"{{"schemaVersion":1,"name":"JPEG sharing","format":"jpeg","quality":{quality},"bitDepth":8,"maxLongEdge":{edge},"outputProfile":"srgb","renderingIntent":"maple-display","metadataPolicy":"strip","namingTemplate":"{{original}}.{{ext}}","destination":"download","directory":null,"watermark":null,"overwritePolicy":"browser"}}"#
    ))
    .unwrap()
}

fn digest(path: &Path) -> u64 {
    std::fs::read(path)
        .unwrap_or_default()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325, |hash, &byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        })
}

fn c(path: &Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

fn bench(label: &str, runs: usize, out: &Path, mut call: impl FnMut() -> i32) {
    let mut times: Vec<f64> = (0..runs)
        .map(|_| {
            let _ = std::fs::remove_file(out);
            let start = Instant::now();
            let rc = call();
            let ms = start.elapsed().as_secs_f64() * 1e3;
            assert_eq!(rc, 0, "{label}: rc {rc}");
            ms
        })
        .collect();
    times.sort_by(f64::total_cmp);
    println!(
        "FFI {label:<34} min {:>9.1} ms  median {:>9.1} ms  digest {:016x}",
        times[0],
        times[times.len() / 2],
        digest(out)
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let raw = PathBuf::from(&args[0]);
    let runs = args.get(1).map_or(5, |r| r.parse().expect("runs"));
    let only = args.get(2).cloned().unwrap_or_default();
    let dir = tempfile::tempdir().unwrap();
    let raw_c = c(&raw);
    let edited_xml = CString::new(EDITED_XMP).unwrap();
    let empty = CString::new("").unwrap();
    let out = |name: &str| dir.path().join(name);
    let wanted = |label: &str| only.is_empty() || label.contains(&only);
    let cases: Vec<Case> = vec![
        (
            "preview_embedded_1280_jpeg",
            out("p.jpg"),
            Box::new(|o| unsafe {
                maple_render_thumbnail_preview_jpeg_to_file(raw_c.as_ptr(), o.as_ptr(), 1280, 0)
            }),
        ),
        (
            "thumb_embedded_512_avif",
            out("t.avif"),
            Box::new(|o| unsafe {
                maple_render_thumbnail_avif_to_file(raw_c.as_ptr(), o.as_ptr(), 512, 0)
            }),
        ),
        (
            "develop_fallback_1280_jpeg",
            out("d1280.jpg"),
            Box::new(|o| unsafe {
                maple_render_develop_jpeg_to_file(
                    raw_c.as_ptr(),
                    std::ptr::null(),
                    1280,
                    0,
                    o.as_ptr(),
                )
            }),
        ),
        (
            "develop_fallback_512_jpeg",
            out("d512.jpg"),
            Box::new(|o| unsafe {
                maple_render_develop_jpeg_to_file(
                    raw_c.as_ptr(),
                    std::ptr::null(),
                    512,
                    0,
                    o.as_ptr(),
                )
            }),
        ),
        (
            "export_full_jpeg_default",
            out("e_default.jpg"),
            Box::new(|o| unsafe {
                let r = recipe(None, 92);
                maple_export_recipe_to_file(
                    raw_c.as_ptr(),
                    empty.as_ptr(),
                    r.as_ptr(),
                    std::ptr::null(),
                    o.as_ptr(),
                )
            }),
        ),
        (
            "export_full_jpeg_edited",
            out("e_edited.jpg"),
            Box::new(|o| unsafe {
                let r = recipe(None, 92);
                maple_export_recipe_to_file(
                    raw_c.as_ptr(),
                    edited_xml.as_ptr(),
                    r.as_ptr(),
                    std::ptr::null(),
                    o.as_ptr(),
                )
            }),
        ),
        (
            "edited_thumb_512_avif",
            out("et.avif"),
            Box::new(|o| unsafe {
                let jpg = c(&dir.path().join("et.jpg"));
                let _ = std::fs::remove_file(dir.path().join("et.jpg"));
                let r = recipe(Some(512), 90);
                let rc = maple_export_recipe_to_file(
                    raw_c.as_ptr(),
                    edited_xml.as_ptr(),
                    r.as_ptr(),
                    std::ptr::null(),
                    jpg.as_ptr(),
                );
                if rc != 0 {
                    return rc;
                }
                maple_render_thumbnail_avif_to_file(jpg.as_ptr(), o.as_ptr(), 512, 0)
            }),
        ),
    ];
    println!(
        "raw={} runs={runs} threads={}",
        raw.display(),
        std::thread::available_parallelism().map_or(0, |n| n.get())
    );
    for (label, path, call) in cases.iter().filter(|(l, _, _)| wanted(l)) {
        let o = c(path);
        bench(label, runs, path, || call(&o));
    }
}
