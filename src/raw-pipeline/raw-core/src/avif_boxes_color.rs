//! ICC belongs to the primary item's associated colour property, not alpha.
use super::*;

pub(super) fn read_icc(iprp: &[u8], primary: u32) -> Option<Vec<u8>> {
    let ipco = find_child_box(iprp, 0, iprp.len(), b"ipco")?;
    let ipma = find_child_box(iprp, 0, iprp.len(), b"ipma")?;
    let associations = transform::parse_ipma_for_item(ipma, primary);
    let mut at = 0;
    let mut index = 1;
    while let Some((kind, start, end)) = box_header(ipco, at, ipco.len()) {
        let payload = ipco.get(start..end)?;
        if kind == *b"colr" && associations.contains(&index) {
            let profile = match payload.get(..4)? {
                b"prof" | b"rICC" => payload.get(4..)?,
                _ => {
                    at = end;
                    index += 1;
                    continue;
                }
            };
            if !profile.is_empty() && profile.len() <= crate::raster_meta::MAX_SIDECAR_BYTES {
                return Some(profile.to_vec());
            }
        }
        at = end;
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        [(body.len() as u32 + 8).to_be_bytes().as_slice(), kind, body].concat()
    }
    fn properties(primary_association: u8, profile_kind: &[u8; 4]) -> Vec<u8> {
        let icc = bx(b"colr", &[profile_kind.as_slice(), b"profile"].concat());
        let ipco = bx(b"ipco", &icc);
        // FullBox, entry count, item 1 with its association, item 2 (alpha).
        let ipma = bx(
            b"ipma",
            &[
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                2,
                0,
                1,
                1,
                primary_association,
                0,
                2,
                1,
                1,
            ],
        );
        [ipco, ipma].concat()
    }
    #[test]
    fn primary_association_controls_profile_selection() {
        for kind in [b"prof", b"rICC"] {
            assert_eq!(
                read_icc(&properties(1, kind), 1).as_deref(),
                Some(b"profile".as_slice())
            );
            assert_eq!(
                read_icc(&properties(0, kind), 1),
                None,
                "alpha-only ICC must be ignored"
            );
            assert_eq!(
                read_icc(&properties(2, kind), 1),
                None,
                "absent property must be ignored"
            );
        }
    }
    #[test]
    fn truncated_colour_properties_are_total() {
        let fixture = properties(1, b"prof");
        for end in 0..fixture.len() {
            assert_eq!(read_icc(&fixture[..end], 1), None);
        }
        assert_eq!(read_icc(&properties(1, b"nclx"), 1), None);
    }
}
