//! Quick smoke test for the X-Trans / X3F decode paths added in #417.
//! Run via `cargo run -p raw-core --example xtrans_probe`.

use raw_core::decode::decode_bytes;

fn main() {
    let fixture_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    let raf = fixture_root.join("test_0008.RAF");
    let x3f = fixture_root.join("test_0016.X3F");

    println!("=== X-Trans (test_0008.RAF) ===");
    match std::fs::read(&raf).map(|b| decode_bytes(&b, "raf")) {
        Ok(Ok(raw)) => {
            println!("decode OK: {}x{}", raw.width, raw.height);
            println!("  cfa={:?}", raw.cfa);
            println!("  make={} model={}", raw.camera_make, raw.camera_model);
            println!("  as_shot_neutral={:?}", raw.as_shot_neutral);
            println!("  black_level={:?}", raw.black_level);
            println!("  white_level={}", raw.white_level);
            println!("  crop_rect={:?}", raw.crop_rect);
            println!("  color_matrices_count={}", raw.color_matrices.len());
            println!("  baseline_exposure={}", raw.baseline_exposure);
        }
        Ok(Err(e)) => println!("decode ERR: {}", e),
        Err(e) => println!("io ERR (fixture missing?): {}", e),
    }

    println!();
    println!("=== Foveon X3F (test_0016.X3F) ===");
    match std::fs::read(&x3f).map(|b| decode_bytes(&b, "x3f")) {
        Ok(Ok(raw)) => println!("decode OK: {}x{}", raw.width, raw.height),
        Ok(Err(e)) => println!("decode ERR (expected — should be UnsupportedFormat): {}", e),
        Err(e) => println!("io ERR (fixture missing?): {}", e),
    }
}
