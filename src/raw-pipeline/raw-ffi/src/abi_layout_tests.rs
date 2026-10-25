use super::*;
use std::ffi::CString;

fn parse(text: &str) -> (usize, Vec<(String, usize)>) {
    let mut parts = text.split(';');
    let size = parts
        .next()
        .and_then(|s| s.strip_prefix("size="))
        .and_then(|s| s.parse().ok())
        .expect("leading size=");
    let fields = parts
        .map(|p| {
            let (name, off) = p.split_once('=').expect("name=offset");
            (name.to_owned(), off.parse().expect("offset"))
        })
        .collect();
    (size, fields)
}

/// Every exported layout is well-formed, its offsets are strictly
/// increasing (declaration order, no two fields aliasing) and end
/// inside the struct, and the known-good `MapleAdjustmentParams` size
/// the WinUI startup guard (`RawFfi.VerifyAbi`) pins is what we export.
#[test]
fn exported_layouts_are_ordered_and_bounded() {
    let names = [
        "MapleScopeStats",
        "MapleAdjustmentParams",
        "MapleToneCurves",
        "MapleSceneLinearBufferF32",
        "MapleCreativeTable",
        "MapleCaptureCreative",
        "MapleCaptureBufferF32",
        "MapleAutoAdjustments",
        "MapleWbSample",
        #[cfg(feature = "gpu")]
        "MapleGpuLiveParams",
        #[cfg(feature = "gpu")]
        "MapleGpuLiveSession",
    ];
    for name in names {
        let text = describe(name).unwrap_or_else(|| panic!("{name} exported"));
        let (size, fields) = parse(&text);
        assert!(!fields.is_empty(), "{name}: no fields");
        assert_eq!(fields[0].1, 0, "{name}: first field at offset 0");
        for w in fields.windows(2) {
            assert!(
                w[0].1 < w[1].1,
                "{name}: {} then {} not ascending",
                w[0].0,
                w[1].0
            );
        }
        assert!(
            fields.last().unwrap().1 < size,
            "{name}: last field inside the struct"
        );
    }
    let (size, fields) = parse(&describe("MapleAdjustmentParams").unwrap());
    assert_eq!(
        size, 752,
        "RawFfi.VerifyAbi pins MapleAdjustmentParams at 752 bytes (#5040 appended 3 f32s, #5099 the wb_hsm tail, #5377 creative_ptr)"
    );
    assert_eq!(fields.last().map(|f| f.0.as_str()), Some("creative_ptr"));
    let (_, curve_fields) = parse(&describe("MapleToneCurves").unwrap());
    assert_eq!(
        curve_fields.last().map(|f| f.0.as_str()),
        Some("color_curve_sat_vs_luma_len")
    );
    let names: Vec<&str> = curve_fields.iter().map(|f| f.0.as_str()).collect();
    let curves_at = names
        .iter()
        .position(|n| *n == "color_curve_hue_vs_hue_ptr")
        .expect("colour-curve block");
    assert_eq!(
        names[curves_at - 7..curves_at],
        [
            "parametric_highlights",
            "parametric_lights",
            "parametric_darks",
            "parametric_shadows",
            "parametric_shadow_split",
            "parametric_midtone_split",
            "parametric_highlight_split",
        ],
        "the parametric regions and splits precede the colour curves (#4738)"
    );
}

#[test]
fn extern_entry_writes_text_and_reports_errors() {
    let name = CString::new("MapleToneCurves").unwrap();
    let mut buf = vec![0u8; 4096];
    let mut len = 0usize;
    let rc = unsafe { maple_abi_layout(name.as_ptr(), buf.as_mut_ptr(), buf.len(), &mut len) };
    assert_eq!(rc, 0);
    assert_eq!(
        std::str::from_utf8(&buf[..len]).unwrap(),
        describe("MapleToneCurves").unwrap()
    );

    let mut small = [0u8; 4];
    let mut need = 0usize;
    let rc = unsafe { maple_abi_layout(name.as_ptr(), small.as_mut_ptr(), small.len(), &mut need) };
    assert_eq!(rc, 2);
    assert_eq!(need, len);

    let unknown = CString::new("NotAStruct").unwrap();
    let mut len = 7usize;
    let rc = unsafe { maple_abi_layout(unknown.as_ptr(), buf.as_mut_ptr(), buf.len(), &mut len) };
    assert_eq!(rc, 1);
    assert_eq!(len, 0);

    let rc = unsafe { maple_abi_layout(std::ptr::null(), buf.as_mut_ptr(), buf.len(), &mut len) };
    assert_eq!(rc, -1);
}
