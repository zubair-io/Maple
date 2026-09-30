//! Durable companion names and independent byte verification (#3940).
//! Paths contain validated digest basenames only; no sidecar supplies a path.
use crate::types::accepted_removal::ContentDigest;
use std::collections::BTreeSet;

pub fn removal_asset_names(records: &str) -> Result<Vec<String>, String> {
    let removals = crate::types::inpaint::decode_removals(records)?;
    let mut names = BTreeSet::new();
    for removal in removals {
        names.insert(format!(
            "{}.f16",
            ContentDigest::parse(&removal.patch_ref)?.hex()
        ));
        if let Some(accepted) = removal.accepted {
            names.insert(format!("{}.mask", accepted.mask.hex()));
        }
    }
    Ok(names.into_iter().collect())
}

pub fn verify_removal_asset(name: &str, bytes: &[u8]) -> Result<(), String> {
    let (hex, mask) = if let Some(hex) = name.strip_suffix(".mask") {
        (hex, true)
    } else if let Some(hex) = name.strip_suffix(".f16") {
        (hex, false)
    } else {
        return Err("unsupported removal companion filename".into());
    };
    ContentDigest::parse(&format!("blake3:{hex}"))?.verify(bytes)?;
    if mask {
        super::removal_mask_from_bytes(bytes)?;
    } else {
        super::patch_from_bytes(bytes)?;
    }
    Ok(())
}

/// Check the current original before publication and again before sidecar
/// visibility. Decode-anchor verification remains the renderer's responsibility.
pub fn verify_removal_source(records: &str, original: &str) -> Result<(), String> {
    let original = ContentDigest::parse(original)?;
    for removal in crate::types::inpaint::decode_removals(records)? {
        if let Some(accepted) = removal.accepted {
            if accepted.source.original != original {
                return Err("original changed since removal preparation".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::removal_mask::RemovalMask;

    #[test]
    fn accepted_source_must_match_the_current_original() {
        let records = include_str!("../../../../../test-fixtures/removal/basic/records.txt");
        let source = include_bytes!("../../../../../test-fixtures/removal/basic/source.dng");
        verify_removal_source(records, ContentDigest::for_bytes(source).as_str()).unwrap();
        assert!(
            verify_removal_source(records, ContentDigest::for_bytes(b"replaced").as_str()).is_err()
        );
        assert!(verify_removal_source(records, "../unsafe").is_err());
    }

    #[test]
    fn companion_names_are_safe_digests_and_bytes_must_be_valid() {
        let bytes = super::super::removal_mask_to_bytes(&RemovalMask {
            source_width: 2,
            source_height: 1,
            x: 0,
            y: 0,
            width: 2,
            height: 1,
            pixels: vec![255, 0],
        })
        .unwrap();
        let name = format!("{}.mask", ContentDigest::for_bytes(&bytes).hex());
        verify_removal_asset(&name, &bytes).unwrap();
        assert!(verify_removal_asset(&format!("../{name}"), &bytes).is_err());
        assert!(verify_removal_asset(&name, b"corrupt").is_err());
        let invalid = b"matching digest but invalid codec";
        assert!(verify_removal_asset(
            &format!("{}.mask", ContentDigest::for_bytes(invalid).hex()),
            invalid
        )
        .is_err());
    }
}
