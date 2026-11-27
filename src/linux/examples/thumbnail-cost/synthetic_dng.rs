use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub const WIDTH: u32 = 6000;
pub const HEIGHT: u32 = 4000;
const STRIP_OFFSET: usize = 518;
const ENTRY_SIZE: usize = 12;
const IMAGE_WIDTH: u16 = 256;
const IMAGE_LENGTH: u16 = 257;
const ROWS_PER_STRIP: u16 = 278;
const STRIP_BYTE_COUNTS: u16 = 279;

pub fn template() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
}

fn set_long(header: &mut [u8], tag: u16, value: u32) -> Result<(), String> {
    let count = usize::from(u16::from_le_bytes([header[8], header[9]]));
    let entry = (0..count)
        .map(|index| 10 + index * ENTRY_SIZE)
        .find(|&entry| u16::from_le_bytes([header[entry], header[entry + 1]]) == tag)
        .ok_or_else(|| format!("the template DNG has no tag {tag}"))?;
    header[entry + 2..entry + 4].copy_from_slice(&4_u16.to_le_bytes());
    header[entry + 8..entry + 12].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

/// A gradient with noise on each Bayer channel, so demosaic and render do real work.
fn sample(x: u32, y: u32, noise: u64) -> u16 {
    let channel = u64::from((y & 1) * 2 + (x & 1));
    let scene = 4000
        + u64::from(x) * 20_000 / u64::from(WIDTH)
        + u64::from(y) * 12_000 / u64::from(HEIGHT)
        + channel * 900;
    u16::try_from(scene + noise % 600).expect("below 65,536 by construction")
}

/// A 6000 x 4000 (24 MP) uncompressed RGGB DNG with the committed template's header.
pub fn write(path: &Path) -> Result<(), String> {
    let template = std::fs::read(template()).map_err(|error| error.to_string())?;
    let mut header = template[..STRIP_OFFSET].to_vec();
    set_long(&mut header, IMAGE_WIDTH, WIDTH)?;
    set_long(&mut header, IMAGE_LENGTH, HEIGHT)?;
    set_long(&mut header, ROWS_PER_STRIP, HEIGHT)?;
    set_long(&mut header, STRIP_BYTE_COUNTS, WIDTH * HEIGHT * 2)?;
    let file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
    out.write_all(&header).map_err(|error| error.to_string())?;
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut row = Vec::with_capacity(WIDTH as usize * 2);
    for y in 0..HEIGHT {
        row.clear();
        for x in 0..WIDTH {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            row.extend_from_slice(&sample(x, y, state).to_le_bytes());
        }
        out.write_all(&row).map_err(|error| error.to_string())?;
    }
    out.flush().map_err(|error| error.to_string())
}
