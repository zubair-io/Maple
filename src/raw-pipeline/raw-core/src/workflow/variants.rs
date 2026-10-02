//! Portable sibling identities, shared by every storage host (#4039 / #2437).
use super::{validation, PRIMARY_VARIANT_ID};

/// Resolve beside an already-computed primary sidecar. This preserves the
/// image/video naming contract while making UUID identities independent of
/// display names, enumeration order, and catalog rows.
pub fn variant_filename(primary_name: &str, variant_id: &str) -> Result<String, String> {
    crate::filename::validate_filename(primary_name).map_err(|e| e.to_string())?;
    let stem = primary_name
        .strip_suffix(".xmp")
        .filter(|stem| !stem.is_empty())
        .ok_or("primary sidecar must have a nonempty stem and .xmp extension")?;
    if primary_name
        .chars()
        .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return Err("primary sidecar contains nonportable filename characters".into());
    }
    let filename = if variant_id == PRIMARY_VARIANT_ID {
        primary_name.to_owned()
    } else {
        validation::identity(variant_id)?;
        format!("{stem}.v{variant_id}.xmp")
    };
    // A sibling must fit common 255-byte filesystem component limits. Never
    // truncate a name/identity or silently resolve to the primary instead.
    if filename.len() > 255 {
        return Err("variant sidecar filename exceeds 255 bytes".into());
    }
    Ok(filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "00000000-0000-0000-0000-000000000064";

    #[test]
    fn primary_paths_and_image_video_sibling_identity_are_stable() {
        for primary in ["IMG_1234.xmp", "IMG_1234.MOV.xmp", "été.夜.xmp"] {
            assert_eq!(variant_filename(primary, "primary").unwrap(), primary);
            let expected = format!("{}.v{ID}.xmp", primary.strip_suffix(".xmp").unwrap());
            assert_eq!(variant_filename(primary, ID).unwrap(), expected);
        }
        assert_ne!(
            variant_filename("IMG_1234.xmp", ID).unwrap(),
            variant_filename("IMG_1234.MOV.xmp", ID).unwrap()
        );
    }

    #[test]
    fn traversal_invalid_identity_and_nonportable_names_never_resolve() {
        for primary in [
            "../photo.xmp",
            "a/photo.xmp",
            "a\\photo.xmp",
            ".xmp",
            "photo.dng",
            "CON.xmp",
            "photo:x.xmp",
            "photo?.xmp",
            "photo\0.xmp",
            "photo\n.xmp",
        ] {
            assert!(variant_filename(primary, ID).is_err(), "{primary:?}");
            assert!(variant_filename(primary, "primary").is_err(), "{primary:?}");
        }
        for id in [
            "",
            "../primary",
            "PRIMARY",
            "v2",
            "00000000-0000-0000-0000-00000000006A",
            "00000000-0000-0000-0000-000000000064\n",
        ] {
            assert!(variant_filename("photo.xmp", id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn byte_limits_reject_without_truncating_an_identity() {
        let longest = format!("{}.xmp", "x".repeat(213));
        assert_eq!(variant_filename(&longest, ID).unwrap().len(), 255);
        assert!(variant_filename(&format!("x{longest}"), ID).is_err());
        assert!(variant_filename(&format!("{}.xmp", "é".repeat(126)), "primary").is_err());
    }
}
