//! ICC belongs to the primary item's associated colour property, not alpha.
use super::*;

pub(crate) fn read_icc(iprp: &[u8], primary: u32) -> Option<&[u8]> {
    read_colour_property(iprp, primary, &[b"prof", b"rICC"])
        .and_then(|payload| payload.get(4..))
        .filter(|profile| !profile.is_empty())
}

pub(crate) fn read_nclx(iprp: &[u8], primary: u32) -> Option<(u16, u16)> {
    let payload = read_colour_property(iprp, primary, &[b"nclx"])?;
    let cicp = payload.get(4..11)?;
    Some((
        u16::from_be_bytes([cicp[0], cicp[1]]),
        u16::from_be_bytes([cicp[2], cicp[3]]),
    ))
}

fn read_colour_property<'a>(iprp: &'a [u8], primary: u32, kinds: &[&[u8; 4]]) -> Option<&'a [u8]> {
    let ipco = find_child_box(iprp, 0, iprp.len(), b"ipco")?;
    let ipma = find_child_box(iprp, 0, iprp.len(), b"ipma")?;
    let associations = transform::parse_ipma_for_item(ipma, primary);
    let mut at = 0;
    let mut index = 1;
    while let Some((kind, start, end)) = box_header(ipco, at, ipco.len()) {
        let payload = ipco.get(start..end)?;
        if kind == *b"colr"
            && associations.contains(&index)
            && kinds
                .iter()
                .any(|kind| payload.get(..4) == Some(kind.as_slice()))
        {
            return Some(payload);
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
                read_icc(&properties(1, kind), 1),
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
    fn nclx_requires_a_complete_primary_item_association() {
        let nclx = bx(b"colr", b"nclx\0\x0c\0\x0d\0\x06\x80");
        let ipco = bx(b"ipco", &nclx);
        for association in [0, 1, 2] {
            let fixture = properties(association, b"prof");
            let ipma = find_child_box(&fixture, 0, fixture.len(), b"ipma").unwrap();
            let iprp = [ipco.clone(), bx(b"ipma", ipma)].concat();
            assert_eq!(read_nclx(&iprp, 1), (association == 1).then_some((12, 13)));
            for end in 0..iprp.len() {
                assert_eq!(read_nclx(&iprp[..end], 1), None);
            }
        }
    }

    #[test]
    fn oversized_profile_presence_is_not_capped() {
        let profile = vec![0; crate::raster_meta::MAX_SIDECAR_BYTES + 1];
        let ipco = bx(
            b"ipco",
            &bx(b"colr", &[b"prof".as_slice(), &profile].concat()),
        );
        let association = properties(1, b"prof");
        let ipma = find_child_box(&association, 0, association.len(), b"ipma").unwrap();
        let iprp = [ipco, bx(b"ipma", ipma)].concat();
        assert!(read_icc(&iprp, 1).is_some());
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
