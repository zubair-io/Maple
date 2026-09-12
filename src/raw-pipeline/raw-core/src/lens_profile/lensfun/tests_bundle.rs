use super::bundle::*;

/// A writer mirroring `convert_lensfun_db.py`'s layout, used to build a tiny
/// bundle in-test so the parser is checked field by field.
struct Writer {
    out: Vec<u8>,
    strings: Vec<String>,
}

impl Writer {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            strings: Vec::new(),
        }
    }
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(i) = self.strings.iter().position(|x| x == s) {
            return i as u32;
        }
        self.strings.push(s.to_owned());
        (self.strings.len() - 1) as u32
    }
    fn u8(&mut self, v: u8) {
        self.out.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn terms(&mut self, scale: f32, even: [f32; 3], odd: [f32; 2]) {
        self.f32(scale);
        even.iter().for_each(|v| self.f32(*v));
        odd.iter().for_each(|v| self.f32(*v));
    }
}

fn sample_bundle() -> Vec<u8> {
    let mut w = Writer::new();
    let (sony, e_mount, ilce, fe, m42) = (
        w.intern("Sony"),
        w.intern("Sony E"),
        w.intern("ILCE-7RM4"),
        w.intern("FE 24-70mm f/4 ZA OSS"),
        w.intern("M42"),
    );
    let alpha = w.intern("Alpha 7R IV");
    // mount
    w.u32(e_mount);
    w.u16(1);
    w.u32(m42);
    // camera
    w.u32(sony);
    w.u32(ilce);
    w.u16(1);
    w.u32(alpha);
    w.u32(0);
    w.f32(1.0);
    // lens
    w.u32(sony);
    w.u32(fe);
    w.u16(0);
    w.u16(1);
    w.u32(0);
    w.f32(1.0);
    w.f32(1.5);
    w.u8(0);
    w.u16(1);
    w.f32(24.0);
    w.f32(23.9);
    w.terms(0.97, [0.02, 0.0, 0.0], [0.005, -0.01]);
    w.u16(1);
    w.f32(24.0);
    w.f32(23.9);
    w.terms(1.0002, [0.0001, 0.0, 0.0], [0.0, 0.0]);
    w.terms(0.9998, [-0.0002, 0.0, 0.0], [0.0, 0.0]);
    w.u16(2);
    for (ap, k) in [(4.0, [-0.3, 0.4, -0.5]), (5.6, [-0.2, 0.3, -0.4])] {
        w.f32(24.0);
        w.f32(ap);
        w.f32(5.0);
        k.iter().for_each(|v| w.f32(*v));
    }
    let body = std::mem::take(&mut w.out);
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for n in [w.strings.len() as u32, 1, 1, 1] {
        out.extend_from_slice(&n.to_le_bytes());
    }
    let mut commit = *b"12f5976\0\0\0\0\0";
    commit[7..].fill(0);
    out.extend_from_slice(&commit);
    out.extend_from_slice(b"2026-09-11");
    for s in &w.strings {
        out.extend_from_slice(&(s.len() as u16).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    out.extend_from_slice(&body);
    out
}

#[test]
fn parses_every_field_of_the_layout() {
    let db = parse(&sample_bundle()).unwrap();
    assert_eq!(db.version.commit, "12f5976");
    assert_eq!(db.version.date, "2026-09-11");
    assert_eq!(db.mounts[0].name, "Sony E");
    assert_eq!(db.mounts[0].compat, ["M42"]);
    let cam = &db.cameras[0];
    assert_eq!(
        (cam.maker.as_str(), cam.model.as_str()),
        ("Sony", "ILCE-7RM4")
    );
    assert_eq!(cam.variants, ["Alpha 7R IV"]);
    assert_eq!((cam.mount, cam.crop), (0, 1.0));
    let lens = &db.lenses[0];
    assert_eq!(lens.model, "FE 24-70mm f/4 ZA OSS");
    assert!(lens.rectilinear && lens.mounts == [0]);
    assert_eq!((lens.crop, lens.aspect), (1.0, 1.5));
    let d = lens.distortion[0];
    assert_eq!((d.focal, d.real_focal), (24.0, f64::from(23.9f32)));
    assert_eq!(d.terms.scale, f64::from(0.97f32));
    assert_eq!(d.terms.odd, [f64::from(0.005f32), f64::from(-0.01f32)]);
    assert_eq!(lens.tca[0].blue.scale, f64::from(0.9998f32));
    assert_eq!(lens.vignetting.len(), 2);
    assert_eq!(lens.vignetting[1].aperture, f64::from(5.6f32));
}

#[test]
fn truncation_bad_magic_and_trailing_bytes_are_errors() {
    let bytes = sample_bundle();
    assert!(parse(&bytes[..bytes.len() - 3])
        .unwrap_err()
        .contains("truncated"));
    let mut bad = bytes.clone();
    bad[0] = b'X';
    assert!(parse(&bad).unwrap_err().contains("magic"));
    let mut long = bytes.clone();
    long.push(0);
    assert!(parse(&long).unwrap_err().contains("trailing"));
    let mut version = bytes;
    version[4] = 9;
    assert!(parse(&version).unwrap_err().contains("version 9"));
}
