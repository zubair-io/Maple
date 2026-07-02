//! Print the aggressively-normalised (make, model) keys that the now-removed
//! `camera_calibration::baseline_exposure` table once used, given a list of
//! (raw_make, raw_model) inputs from the fixture set. Retained as a debugging
//! aid for any future per-body lookup that needs the same normalisation
//! shape; the function being keyed against is gone (see ticket #370).
//!
//! Usage: cargo run --release --example normalize-camera-key

fn normalize(make: &str, model: &str) -> (String, String, String) {
    let make_n = make.trim().to_ascii_lowercase();
    let model_n = model
        .trim()
        .trim_start_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
        .trim()
        .to_ascii_lowercase();
    let model_bare = model_n.trim_start_matches(&make_n[..]).trim().to_string();
    (make_n, model_n, model_bare)
}

fn main() {
    let fixtures = [
        ("Panasonic", "DMC-LX2"),
        ("Canon", "EOS 5DS R"),
        ("Hasselblad", "H5D-40"),
        ("Fujifilm", "GFX 50S"),
        ("Canon", "EOS 5D Mark IV"),
        ("Sony", "ILCE-7RM4"),
        ("Fujifilm", "GFX 50R"),
        ("Nikon", "D850"),
    ];
    println!(
        "{:<14} {:<22} {:<14} {:<14}",
        "make", "model_in", "model_norm", "model_bare"
    );
    println!("{}", "-".repeat(70));
    for (m, mo) in fixtures {
        let (make_n, model_n, model_bare) = normalize(m, mo);
        println!(
            "{:<14} {:<22} {:<14} {:<14}",
            make_n, mo, model_n, model_bare
        );
    }
}
