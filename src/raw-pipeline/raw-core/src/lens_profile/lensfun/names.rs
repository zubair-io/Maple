//! Canonical spellings for matching EXIF identity against Lensfun entries.
//!
//! Bodies write lens names one way ("FE 24-70mm F4 ZA OSS",
//! "EF70-200mm f/2.8L IS II USM", "XF35mmF2 R WR") and Lensfun another
//! ("FE 24-70mm f/4 ZA OSS", "Canon EF 70-200mm f/2.8L IS II USM",
//! "XF 35mm f/2 R WR"). The differences are only the maker prefix, the
//! `f/` spelling of the aperture and whitespace, so a canonical form that
//! drops exactly those makes an *exact* comparison possible without any
//! fuzzy scoring. `src/scripts/convert_lensfun_db.py` implements the same
//! rule; the two are tested with the same table.

/// Lowercase, drop a leading maker prefix, `f/` → `f`, drop all whitespace.
pub fn canonical(maker: &str, name: &str) -> String {
    let lower = name.to_lowercase();
    let maker = maker.to_lowercase();
    let stripped = lower.strip_prefix(&format!("{maker} ")).unwrap_or(&lower);
    stripped
        .replace("f/", "f")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// Camera models additionally drop a leading token equal to the maker's
/// first token, so "NIKON CORPORATION" / "NIKON D850" and "Nikon" /
/// "Nikon D850" both become `d850`.
pub fn canonical_camera(maker: &str, model: &str) -> String {
    let lower = model.to_lowercase();
    let first = maker.split_whitespace().next().unwrap_or("").to_lowercase();
    let stripped = if !first.is_empty() {
        lower
            .strip_prefix(&format!("{first} "))
            .unwrap_or(&lower)
            .to_owned()
    } else {
        lower
    };
    canonical(maker, &stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_and_lensfun_spellings_meet() {
        for (maker, exif, lf) in [
            ("Sony", "FE 24-70mm F4 ZA OSS", "FE 24-70mm f/4 ZA OSS"),
            (
                "Canon",
                "EF70-200mm f/2.8L IS II USM",
                "Canon EF 70-200mm f/2.8L IS II USM",
            ),
            ("Canon", "EF50mm f/1.2L USM", "Canon EF 50mm f/1.2L USM"),
            ("Fujifilm", "XF35mmF2 R WR", "XF 35mm f/2 R WR"),
        ] {
            assert_eq!(canonical(maker, exif), canonical(maker, lf), "{exif}");
        }
        assert_eq!(
            canonical("Sony", "FE 24-70mm F4 ZA OSS"),
            "fe24-70mmf4zaoss"
        );
    }

    #[test]
    fn camera_models_drop_the_maker_token() {
        assert_eq!(
            canonical_camera("NIKON CORPORATION", "NIKON D850"),
            canonical_camera("Nikon", "Nikon D850")
        );
        assert_eq!(canonical_camera("Nikon", "Nikon D850"), "d850");
        assert_eq!(
            canonical_camera("Canon", "Canon EOS 5D Mark III"),
            "eos5dmarkiii"
        );
        assert_eq!(canonical_camera("SONY", "ILCE-7RM4"), "ilce-7rm4");
    }
}
