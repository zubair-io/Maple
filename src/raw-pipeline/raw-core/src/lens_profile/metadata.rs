//! Read capture identity that rawler 0.7.2's generic EXIF extraction omits.
use rawler::formats::tiff::{Value, IFD};
use rawler::tags::ExifTag;

/// Keep a decoder's maker-specific lens identity when present. This fallback
/// reads the actual LensModel ASCII tag, including the EXIF sub-IFD, without
/// inferring a lens from focal length or guessing a numeric maker-note ID.
pub(crate) fn lens_model(root: &IFD) -> Option<String> {
    let entry = crate::dng_ifd_walker::find_entry_recursive(
        root,
        ExifTag::LensModel,
        crate::dng_ifd_walker::DEFAULT_MAX_DEPTH,
    )?;
    let Value::Ascii(value) = &entry.value else {
        return None;
    };
    let name = value.strings().first()?.trim_end_matches('\0').trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::bits::Endian;
    use rawler::formats::tiff::{Entry, TiffAscii};
    use std::collections::{BTreeMap, HashMap};

    fn ifd(offset: u32, value: Option<Value>) -> IFD {
        let mut entries = BTreeMap::new();
        if let Some(value) = value {
            let tag = ExifTag::LensModel as u16;
            entries.insert(
                tag,
                Entry {
                    tag,
                    value,
                    embedded: None,
                },
            );
        }
        IFD {
            offset,
            base: 0,
            corr: 0,
            next_ifd: 0,
            entries,
            endian: Endian::Little,
            sub: HashMap::new(),
            chain: Vec::new(),
        }
    }

    #[test]
    fn reads_the_authored_exif_sub_ifd_identity() {
        let mut root = ifd(8, None);
        root.sub.insert(
            0x8769,
            vec![ifd(100, Some(Value::Ascii(TiffAscii::new("  Prime  \0"))))],
        );
        assert_eq!(lens_model(&root).as_deref(), Some("Prime"));
        root.entries.insert(
            ExifTag::LensModel as u16,
            Entry {
                tag: ExifTag::LensModel as u16,
                value: Value::Ascii(TiffAscii::new("Root lens")),
                embedded: None,
            },
        );
        assert_eq!(lens_model(&root).as_deref(), Some("Root lens"));
    }

    #[test]
    fn absent_empty_and_numeric_tags_do_not_invent_identity() {
        for value in [
            None,
            Some(Value::Ascii(TiffAscii::new(" \0"))),
            Some(Value::Long(vec![35])),
        ] {
            assert_eq!(lens_model(&ifd(8, value)), None);
        }
    }
}
