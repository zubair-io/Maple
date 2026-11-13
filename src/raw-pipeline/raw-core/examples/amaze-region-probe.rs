//! Read-only native AMaZE regional diagnostic. Cropped results are not a physical gate.
use raw_core::{decode, demosaic::amaze::amaze, image::Image, linearize};
use std::{error::Error, io::Write, path::Path};
fn save(path: &Path, image: &Image) -> Result<(), Box<dyn Error>> {
    let mut f = std::io::BufWriter::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?,
    );
    for pixel in &image.pixels {
        for v in pixel {
            f.write_all(&v.to_le_bytes())?;
        }
    }
    f.flush()?;
    Ok(())
}
fn main() -> Result<(), Box<dyn Error>> {
    let a = std::env::args().collect::<Vec<_>>();
    if a.len() != 7 {
        return Err("usage: amaze-region-probe RAW X Y WIDTH HEIGHT NEW_OUTPUT_DIR".into());
    }
    let [x, y, w, h] = [
        a[2].parse::<u32>()?,
        a[3].parse()?,
        a[4].parse()?,
        a[5].parse()?,
    ];
    let raw = decode::decode(Path::new(&a[1]))?;
    if !raw.cfa.is_bayer_2x2()
        || x % 2 != 0
        || y % 2 != 0
        || w < 64
        || h < 64
        || x.checked_add(w).is_none_or(|r| r > raw.width)
        || y.checked_add(h).is_none_or(|b| b > raw.height)
    {
        return Err("expected even-origin bounded Bayer region of at least64px".into());
    }
    let dir = Path::new(&a[6]);
    std::fs::create_dir(dir)?;
    let mosaic = linearize::sensor_linearize_region(&raw, x, y, w, h);
    save(&dir.join("mosaic.f32"), &mosaic)?;
    let native = amaze(&mosaic, raw.cfa);
    save(&dir.join("native.f32"), &native)?;
    let identity = serde_json::json!({"origin":[x,y],"dimensions":[w,h],"as_shot_neutral":raw.as_shot_neutral,"baseline_exposure":raw.baseline_exposure,"scope":"cropped diagnostic, not full physical color gate; sensor RGB after FCS"});
    std::fs::write(
        dir.join("identity.json"),
        serde_json::to_string_pretty(&identity)?,
    )?;
    println!("{identity}");
    Ok(())
}
