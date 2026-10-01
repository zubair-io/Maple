use super::decode;
use std::io::Cursor;

fn tiff(width: u32, height: u32, float: bool) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    let mut encoder = tiff::encoder::TiffEncoder::new(&mut output).unwrap();
    if float {
        encoder
            .write_image::<tiff::encoder::colortype::RGB32Float>(4, 4, &[0.5; 48])
            .unwrap();
    } else {
        encoder
            .write_image::<tiff::encoder::colortype::RGB8>(4, 4, &[128; 48])
            .unwrap();
    }
    let mut bytes = output.into_inner();
    let first = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes(bytes[first..first + 2].try_into().unwrap()) as usize;
    for i in 0..count {
        let at = first + 2 + i * 12;
        let value = match u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) {
            256 => width,
            257 => height,
            _ => continue,
        };
        assert_eq!(
            u16::from_le_bytes(bytes[at + 2..at + 4].try_into().unwrap()),
            4
        );
        bytes[at + 8..at + 12].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[test]
fn rejects_oversized_jpeg_and_tiff_before_decoding_pixels() {
    let mut jpeg = super::tests::jpeg();
    let sof = jpeg.windows(2).position(|m| m == [0xff, 0xc0]).unwrap();
    jpeg[sof + 5..sof + 7].copy_from_slice(&20_000u16.to_be_bytes());
    jpeg[sof + 7..sof + 9].copy_from_slice(&20_000u16.to_be_bytes());
    for bytes in [jpeg, tiff(20_000, 20_000, false)] {
        let error = decode(&bytes).unwrap_err().to_string();
        assert!(error.contains("268000000 pixel limit"), "{error}");
    }
}

#[test]
fn rejects_excessive_decode_bytes_below_pixel_ceiling() {
    let error = decode(&tiff(16_000, 16_000, true)).unwrap_err().to_string();
    assert!(error.contains("Memory limit exceeded"), "{error}");
}
